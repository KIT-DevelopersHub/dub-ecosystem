// ChatRoom — the chat-owned Realtime Worker (Durable Object). One DO instance per
// channel (routed by getByName(channelId)). Responsibilities (design 4-8 / theme11):
//   - ws-ticket verification (HMAC, chat self-owned secret) at connect time
//   - Origin allow-listing (gateway is NOT on the WS path; CORS/Origin is enforced here)
//   - WS connection management via the Hibernation API
//   - fanout of ChatRealtimeEvent to every socket in the channel (RPC `publish`)
//
// The HTTP master (conversation source of truth) never fans out directly: it calls
// this DO through the frozen `RealtimePublisher` contract (see DoRealtimePublisher).
// WS is gateway-bypassing / DO-direct: the client connects to the `doUrl` returned
// by GET /channels/:id/ws-ticket and presents the ticket as a query param.
import { DurableObject } from "cloudflare:workers";
import type { chat } from "@dub/types";
import { verifyWsTicket } from "./wsticket";

export interface ChatRoomEnv {
  // chat self-owned HMAC secret (Worker Secret in prod; same value the issuer signs with).
  WS_TICKET_SECRET?: string;
  // Comma-separated Origin allow-list. Browser clients must match; native/mobile
  // clients send no Origin and are allowed. Defaults to the SPA origin.
  CHAT_RT_ALLOWED_ORIGINS?: string;
}

// Dev-only fallback; MUST match the issuer's fallback in src/index.ts.
const DEV_WS_SECRET = "dev-insecure-ws-ticket-secret";
const DEFAULT_ALLOWED_ORIGINS = "https://app.developershub.jp";

// Per-socket metadata survives hibernation via serializeAttachment.
interface SocketMeta {
  userId: string;
  channelId: string;
}

function errorResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export class ChatRoom extends DurableObject<ChatRoomEnv> {
  /**
   * WS upgrade endpoint. The routing Worker forwards `/ws/:channelId?ticket=...`
   * here (stub = getByName(channelId)). This method is the sole gate: it verifies
   * the HMAC ticket, checks the ticket's channel matches, enforces Origin, then
   * accepts a hibernatable WebSocket. No auth state is trusted from the caller.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/\/ws\/([^/]+)$/);
    const channelId = match ? decodeURIComponent(match[1]!) : null;
    if (!channelId) return errorResponse(400, "CHAT_WS_MISSING_CHANNEL");

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return errorResponse(426, "CHAT_WS_UPGRADE_REQUIRED");
    }

    const origin = request.headers.get("Origin");
    if (origin !== null && !this.isOriginAllowed(origin)) {
      return errorResponse(403, "CHAT_WS_ORIGIN_FORBIDDEN");
    }

    const ticket = url.searchParams.get("ticket");
    if (!ticket) return errorResponse(401, "CHAT_WS_TICKET_MISSING");

    const claims = await verifyWsTicket(this.secret(), ticket);
    if (!claims) return errorResponse(401, "CHAT_WS_TICKET_INVALID");
    if (claims.channelId !== channelId) return errorResponse(403, "CHAT_WS_TICKET_CHANNEL_MISMATCH");

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Hibernation API: the runtime keeps the socket without holding this DO in
    // memory; webSocketMessage/Close re-hydrate it on demand.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ userId: claims.userId, channelId } satisfies SocketMeta);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Fanout entrypoint (RPC). Called by the HTTP master via DoRealtimePublisher
   * after a DB commit. Broadcasts the event as JSON to every connected socket and
   * returns the delivered count. Best-effort per socket: a dead peer never blocks
   * the rest.
   */
  async publish(event: chat.ChatRealtimeEvent): Promise<number> {
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

  // P0: clients are read-only over WS (posting/editing goes through the HTTP master).
  // We only answer a lightweight liveness ping so the client can detect a stale link.
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
    const list = (this.env.CHAT_RT_ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return list.includes(origin);
  }
}
