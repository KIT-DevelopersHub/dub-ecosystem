// GanttRoom — the gantt-owned Realtime Worker (Durable Object). One DO instance per
// event (routed by getByName(eventId)). It is the collaboration hub for a single gantt:
//   - ws-ticket verification (HMAC, gantt self-owned secret) at connect time
//   - Origin allow-listing (the gateway is NOT on the WS path; enforced here)
//   - WS connection management via the Hibernation API (survives isolate eviction)
//   - presence fanout (who is viewing/editing) deduped per user across tabs
//   - live data-change fanout (a peer saved → others refetch the authoritative rows)
//
// The DB remains the single source of truth: this DO stores NO business rows. It relays
// signals only; confirmed values always come back through the REST API (last-write-wins).
// WS is gateway-bypassing / DO-direct: the client connects to the `doUrl` returned by
// GET /gantt/ws-ticket and presents the ticket as a query param.
import { DurableObject } from "cloudflare:workers";
import { gantt } from "@dub/types";
import type { common } from "@dub/types";
import { verifyWsTicket } from "./wsticket";
import { buildPresenceSnapshot, presenceEqual, type SocketMeta } from "./presence";

export interface GanttRoomEnv {
  // gantt self-owned HMAC secret (Worker Secret in prod; same value the issuer signs with).
  WS_TICKET_SECRET?: string;
  // Comma-separated Origin allow-list. Browser clients must match; native/mobile clients
  // (no Origin header) are allowed. Defaults to the SPA origin.
  GANTT_RT_ALLOWED_ORIGINS?: string;
}

// Dev-only fallback; MUST match the issuer's fallback in src/index.ts / deps.
const DEV_WS_SECRET = "dev-insecure-ws-ticket-secret";
const DEFAULT_ALLOWED_ORIGINS = "https://app.developershub.jp";
// How often the reaper wakes to evict half-open sockets (no heartbeat within TTL).
const ALARM_INTERVAL_MS = 20_000;

function errorResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export class GanttRoom extends DurableObject<GanttRoomEnv> {
  /**
   * WS upgrade endpoint. The routing Worker forwards `/ws/:eventId?ticket=...` here
   * (stub = getByName(eventId)). This method is the sole gate: it verifies the HMAC
   * ticket, checks the ticket's event matches, enforces Origin, then accepts a
   * hibernatable WebSocket. No auth state is trusted from the caller.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/\/ws\/([^/]+)$/);
    const eventId = match ? decodeURIComponent(match[1]!) : null;
    if (!eventId) return errorResponse(400, "GANTT_WS_MISSING_EVENT");

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return errorResponse(426, "GANTT_WS_UPGRADE_REQUIRED");
    }

    const origin = request.headers.get("Origin");
    if (origin !== null && !this.isOriginAllowed(origin)) {
      return errorResponse(403, "GANTT_WS_ORIGIN_FORBIDDEN");
    }

    const ticket = url.searchParams.get("ticket");
    if (!ticket) return errorResponse(401, "GANTT_WS_TICKET_MISSING");

    const claims = await verifyWsTicket(this.secret(), ticket);
    if (!claims) return errorResponse(401, "GANTT_WS_TICKET_INVALID");
    if (claims.eventId !== eventId) return errorResponse(403, "GANTT_WS_TICKET_EVENT_MISMATCH");

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Hibernation API: the runtime keeps the socket without holding this DO in memory;
    // webSocketMessage/Close re-hydrate it on demand.
    this.ctx.acceptWebSocket(server);
    const meta: SocketMeta = {
      userId: claims.userId,
      ...(claims.displayName ? { displayName: claims.displayName } : {}),
      editing: false,
      lastSeen: Date.now(),
    };
    server.serializeAttachment(meta);

    // Announce the newcomer to everyone already here, and make sure the reaper runs.
    this.broadcastPresence();
    await this.ensureAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Server-side data-change fanout (RPC). Called by the HTTP master (events-async /
   * PATCH row) after a DB commit so that changes made OUTSIDE this room's own sockets
   * (e.g. via the event pipeline) still reach connected clients. Broadcast to ALL
   * sockets. Best-effort per socket.
   */
  async broadcastChange(change: gantt.GanttChangeKind | string, actorId: common.UserId, taskId?: common.TaskId | null): Promise<number> {
    return this.fanout(
      { kind: "data.changed", change, actorId, at: new Date().toISOString() as common.ISODateTime, ...(taskId ? { taskId } : {}) },
      null,
    );
  }

  /** Current connection count (presence primitive; used by tests). */
  async presence(): Promise<number> {
    return this.ctx.getWebSockets().length;
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let msg: gantt.GanttClientMessage;
    try {
      msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message)) as gantt.GanttClientMessage;
    } catch {
      return; // ignore malformed frames
    }
    const meta = this.metaOf(ws);
    if (!meta) return;
    meta.lastSeen = Date.now();

    switch (msg.t) {
      case "hello": {
        // send the current snapshot to just this socket
        ws.serializeAttachment(meta);
        this.sendTo(ws, { kind: "presence", users: buildPresenceSnapshot(this.allMetas()) });
        return;
      }
      case "ping": {
        ws.serializeAttachment(meta);
        try {
          ws.send("pong");
        } catch {
          /* peer gone */
        }
        return;
      }
      case "state": {
        meta.editing = !!msg.editing;
        meta.editingTaskId = msg.editing ? (msg.editingTaskId ?? null) : null;
        ws.serializeAttachment(meta);
        this.broadcastPresence();
        return;
      }
      case "change": {
        ws.serializeAttachment(meta);
        // relay to OTHERS (the author already applied it optimistically)
        this.fanout(
          {
            kind: "data.changed",
            change: msg.change,
            actorId: meta.userId,
            at: new Date().toISOString() as common.ISODateTime,
            ...(msg.taskId ? { taskId: msg.taskId } : {}),
          },
          ws,
        );
        return;
      }
      default:
        return;
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      /* already closing */
    }
    // The closing socket may still be listed by getWebSockets() during this callback, so
    // exclude it from the snapshot — otherwise a departed user lingers in the avatar bar.
    this.broadcastPresenceExcept(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, "internal error");
    } catch {
      /* already closing */
    }
    this.broadcastPresenceExcept(ws);
  }

  /** Reaper: evict sockets whose last heartbeat is older than the presence TTL (half-
   *  open / crashed tab), then re-broadcast presence if it changed and reschedule while
   *  any socket remains. This is what makes a stale avatar disappear without a clean close. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const before = buildPresenceSnapshot(this.allMetas());
    for (const ws of this.ctx.getWebSockets()) {
      const meta = this.metaOf(ws);
      if (meta && now - meta.lastSeen > gantt.GANTT_PRESENCE_TTL_MS) {
        try {
          ws.close(1001, "presence timeout");
        } catch {
          /* already gone */
        }
      }
    }
    const after = buildPresenceSnapshot(this.allMetas());
    if (!presenceEqual(before, after)) this.fanout({ kind: "presence", users: after }, null);
    if (this.ctx.getWebSockets().length > 0) await this.ensureAlarm();
  }

  // ---- helpers ----

  private async ensureAlarm(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  private metaOf(ws: WebSocket): SocketMeta | null {
    try {
      const raw = ws.deserializeAttachment() as SocketMeta | null;
      return raw ?? null;
    } catch {
      return null;
    }
  }

  private allMetas(): SocketMeta[] {
    const out: SocketMeta[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const m = this.metaOf(ws);
      if (m) out.push(m);
    }
    return out;
  }

  private broadcastPresence(): void {
    this.fanout({ kind: "presence", users: buildPresenceSnapshot(this.allMetas()) }, null);
  }

  /** Broadcast presence computed from every socket EXCEPT `exclude` (a socket that is
   *  closing but may still appear in getWebSockets() during the close callback). */
  private broadcastPresenceExcept(exclude: WebSocket): void {
    const metas: SocketMeta[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const m = this.metaOf(ws);
      if (m) metas.push(m);
    }
    this.fanout({ kind: "presence", users: buildPresenceSnapshot(metas) }, exclude);
  }

  private sendTo(ws: WebSocket, event: gantt.GanttRealtimeEvent): void {
    try {
      ws.send(JSON.stringify(event));
    } catch {
      /* peer gone */
    }
  }

  /** Send an event to every socket, optionally excluding one (the author). */
  private fanout(event: gantt.GanttRealtimeEvent, except: WebSocket | null): number {
    const data = JSON.stringify(event);
    let delivered = 0;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(data);
        delivered++;
      } catch {
        /* socket already gone; ignore */
      }
    }
    return delivered;
  }

  private secret(): string {
    return this.env.WS_TICKET_SECRET ?? DEV_WS_SECRET;
  }

  private isOriginAllowed(origin: string): boolean {
    const list = (this.env.GANTT_RT_ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return list.includes(origin);
  }
}
