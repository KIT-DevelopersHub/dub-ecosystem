// GanttRoom — the gantt-owned Realtime Worker (Durable Object). One DO instance per
// event (routed by getByName(eventId)); it holds the WS connections of everyone viewing
// that event's gantt. 写経 of chat-service/src/chat-room-do.ts. Responsibilities:
//   - ws-ticket verification (HMAC, gantt self-owned secret) at connect time
//   - Origin allow-listing (the gateway is NOT on the WS path; enforced here)
//   - WS connection management via the Hibernation API (idle sockets cost nothing —
//     the runtime evicts this DO from memory and re-hydrates on message/close)
//   - delta fanout of GanttRealtimeEvent to every socket in the room (RPC `publish`)
//
// The HTTP master (gantt-service, the read model) never fans out directly: it calls this
// DO through the RealtimePublisher contract (see realtime.ts) AFTER a write commits, so
// RT never leads the source of truth. WS is gateway-bypassing / DO-direct: the client
// connects to the `doUrl` from GET /gantt/ws-ticket and presents the ticket as a query
// param. Holds no durable rows (WS coordinator only) — cost is $0 on the free plan.
import { DurableObject } from "cloudflare:workers";
import type { gantt } from "@dub/types";
import { verifyWsTicket } from "./wsticket";
import { buildPresenceSnapshot, type SocketMeta } from "./presence";

export interface GanttRoomEnv {
  // gantt self-owned HMAC secret (Worker Secret in prod; same value the issuer signs with).
  WS_TICKET_SECRET?: string;
  // Comma-separated Origin allow-list. Browser clients must match; native/mobile clients
  // send no Origin and are allowed. Defaults to the SPA origin.
  GANTT_RT_ALLOWED_ORIGINS?: string;
}

// Dev-only fallback; MUST match the issuer's fallback in src/index.ts / app.ts.
const DEV_WS_SECRET = "dev-insecure-ws-ticket-secret";
const DEFAULT_ALLOWED_ORIGINS = "https://app.developershub.jp";

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
    // webSocketMessage/Close re-hydrate it on demand ($0 while idle).
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      userId: claims.userId,
      eventId,
      ...(claims.displayName ? { displayName: claims.displayName } : {}),
      connectedAt: Date.now(),
    } satisfies SocketMeta);

    // A viewer joined → the roster changed. Fan the fresh presence snapshot out to
    // everyone (the newcomer included, so it renders "who is here" immediately).
    this.broadcastPresence(eventId);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Fanout entrypoint (RPC). Called by the HTTP master via DoRealtimePublisher AFTER a
   * write commits. Broadcasts the delta as JSON to every connected socket and returns
   * the delivered count. Best-effort per socket: a dead peer never blocks the rest.
   */
  async publish(event: gantt.GanttRealtimeEvent): Promise<number> {
    const data = JSON.stringify(event);
    let delivered = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
        delivered++;
      } catch {
        // socket already gone; ignore
      }
    }
    return delivered;
  }

  /** Current connection count (presence primitive). */
  async presence(): Promise<number> {
    return this.ctx.getWebSockets().length;
  }

  // Clients are read-only over WS (all writes go through the HTTP master). We answer a
  // lightweight liveness ping so the client can detect a stale link and reconnect, and a
  // `hello` with the current presence snapshot (unicast) so a just-connected tab paints
  // "who is here" without waiting for the next roster change.
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "ping") {
      ws.send("pong");
      return;
    }
    if (message === "hello") {
      const meta = ws.deserializeAttachment() as SocketMeta | null;
      if (meta) ws.send(this.presenceFrame(meta.eventId));
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Read the leaving socket's event BEFORE closing so we can refresh the roster.
    const meta = ws.deserializeAttachment() as SocketMeta | null;
    try {
      ws.close(code, reason);
    } catch {
      // already closing
    }
    // A viewer left → recompute presence for the room, excluding this now-closed socket,
    // so its avatar disappears for the remaining peers immediately.
    if (meta) this.broadcastPresence(meta.eventId, ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    const meta = ws.deserializeAttachment() as SocketMeta | null;
    try {
      ws.close(1011, "internal error");
    } catch {
      // already closing
    }
    if (meta) this.broadcastPresence(meta.eventId, ws);
  }

  /** Build the current presence snapshot for `eventId`, optionally excluding one socket
   *  (the one that is leaving — it may still appear in getWebSockets() mid-close). */
  private snapshotUsers(eventId: string, exclude?: WebSocket): gantt.GanttPresenceUser[] {
    const metas: SocketMeta[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const meta = ws.deserializeAttachment() as SocketMeta | null;
      if (meta && meta.eventId === eventId) metas.push(meta);
    }
    return buildPresenceSnapshot(metas);
  }

  /** Serialized `presence` frame for `eventId` (the snapshot, sent whole — not a delta). */
  private presenceFrame(eventId: string, exclude?: WebSocket): string {
    const event: gantt.GanttRealtimeEvent = {
      kind: "presence",
      eventId,
      users: this.snapshotUsers(eventId, exclude),
      at: new Date().toISOString(),
    };
    return JSON.stringify(event);
  }

  /** Fan the current presence snapshot out to every socket in the room (best-effort;
   *  a dead peer never blocks the rest). `exclude` skips a leaving socket. */
  private broadcastPresence(eventId: string, exclude?: WebSocket): void {
    const data = this.presenceFrame(eventId, exclude);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      try {
        ws.send(data);
      } catch {
        // socket already gone; ignore
      }
    }
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
