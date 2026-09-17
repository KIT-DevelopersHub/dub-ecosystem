// InboxRoom — the notification-owned Realtime hub (Durable Object). ONE instance per
// USER (routed by getByName(userId)). It mirrors chat-service's ChatRoom (ws-ticket
// verify + Origin allow-list + Hibernation-API WS management + RPC fanout) but is scoped
// to a single user's inbox instead of a chat channel.
//
// Responsibilities:
//   - verify the HMAC ws-ticket (userId claim) at connect time
//   - enforce the Origin allow-list (the gateway is NOT on the WS path)
//   - hold the user's live WS connections via the Hibernation API (free-tier friendly)
//   - fan out an inbox realtime event (RPC `publish`) to every socket for that user
//
// The HTTP master (ingest, the source of truth) calls `publish` AFTER the D1 inbox row is
// committed, so realtime never leads the source of truth. Fanout is best-effort: a DO push
// failure never fails the notification write that already succeeded.
import { DurableObject } from "cloudflare:workers";
import { verifyWsTicket, DEV_WS_SECRET } from "./wsticket";

export interface InboxRoomEnv {
  // notification self-owned HMAC secret (Worker Secret in prod; same value the issuer signs
  // with). Falls back to a dev-only value that MUST match the issuer's fallback.
  WS_TICKET_SECRET?: string;
  // Comma-separated Origin allow-list. Browser clients must match; native/mobile clients
  // send no Origin and are allowed. Defaults to the SPA origin.
  NOTIF_RT_ALLOWED_ORIGINS?: string;
}

// Dev-only ws-ticket secret fallback (DEV_WS_SECRET) is imported from wsticket.ts so the
// issuer (app.ts) and this verifier share ONE value without app.ts importing this module.
const DEFAULT_ALLOWED_ORIGINS = "https://app.developershub.jp";

// The realtime event pushed to the browser. `inbox-changed` is a lightweight SIGNAL that
// the user's inbox gained a new item; the client responds by refetching its AUTHORITATIVE
// unread count (GET /inbox/unread-count, which respects admin-audience visibility) rather
// than trusting a count computed here — ingest cannot cheaply know a recipient's admin
// status, so pushing an absolute count could momentarily drop admin-audience rows from an
// admin's badge. The refetch keeps the badge exact; this signal just makes it instant.
export interface InboxRealtimeEvent {
  kind: "inbox-changed";
}

interface SocketMeta {
  userId: string;
}

function errorResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export class InboxRoom extends DurableObject<InboxRoomEnv> {
  /**
   * WS upgrade endpoint. The notification Worker forwards `/ws/:userId?ticket=...` here
   * (stub = getByName(userId)). Sole gate: verify the HMAC ticket, check the ticket's
   * user matches the path user, enforce Origin, then accept a hibernatable WebSocket. No
   * auth state is trusted from the caller.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/\/ws\/([^/]+)$/);
    const userId = match ? decodeURIComponent(match[1]!) : null;
    if (!userId) return errorResponse(400, "NOTIF_WS_MISSING_USER");

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return errorResponse(426, "NOTIF_WS_UPGRADE_REQUIRED");
    }

    const origin = request.headers.get("Origin");
    if (origin !== null && !this.isOriginAllowed(origin)) {
      return errorResponse(403, "NOTIF_WS_ORIGIN_FORBIDDEN");
    }

    const ticket = url.searchParams.get("ticket");
    if (!ticket) return errorResponse(401, "NOTIF_WS_TICKET_MISSING");

    const claims = await verifyWsTicket(this.secret(), ticket);
    if (!claims) return errorResponse(401, "NOTIF_WS_TICKET_INVALID");
    if (claims.userId !== userId) return errorResponse(403, "NOTIF_WS_TICKET_USER_MISMATCH");

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Hibernation API: the runtime keeps the socket without holding this DO in memory;
    // webSocketMessage/Close re-hydrate it on demand.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ userId } satisfies SocketMeta);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Fanout entrypoint (RPC). Called by the HTTP master (ingest) AFTER the inbox D1 write.
   * Broadcasts the event as JSON to every connected socket for this user and returns the
   * delivered count. Best-effort per socket: a dead peer never blocks the rest.
   */
  async publish(event: InboxRealtimeEvent = { kind: "inbox-changed" }): Promise<number> {
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

  /** Current connection count (presence primitive / tests). */
  async presence(): Promise<number> {
    return this.ctx.getWebSockets().length;
  }

  // Clients are read-only over WS (all inbox mutations go through the HTTP API). Answer a
  // lightweight liveness ping so a client can detect a stale link.
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "ping") ws.send("pong");
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // already closing
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, "internal error");
    } catch {
      // already closing
    }
  }

  private secret(): string {
    return this.env.WS_TICKET_SECRET ?? DEV_WS_SECRET;
  }

  private isOriginAllowed(origin: string): boolean {
    const list = (this.env.NOTIF_RT_ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return list.includes(origin);
  }
}
