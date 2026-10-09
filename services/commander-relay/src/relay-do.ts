// CommanderRelay — the one Durable Object that pairs the operator's LOCAL Commander (the
// "agent", dialing out from their PC) with signed-in browsers on the Dub app.
//
// Single instance (name "owner"). Hibernation API throughout: an idle relay holds its
// sockets without being billed for duration, and the agent's keepalive "ping" is answered
// by the runtime's auto-response without waking the object — that is what keeps an
// always-connected agent inside the free plan.
//
// Trust: the Worker entry already checked the agent's bearer secret before forwarding the
// agent upgrade. Browser upgrades are verified HERE (ticket + Origin), because the DO is the
// last hop and must not trust anything the caller claims.
import type { DurableObjectState, WebSocket as CfWebSocket } from "@cloudflare/workers-types";
import type { Env } from "./env";
import { originAllowed, parseBrowserFrame, routeAgentFrame, scopeId } from "./protocol";
import { verifyTicket } from "./ticket";

const AGENT_TAG = "agent";
/** Generous for one operator with a few tabs/devices; bounds what a leaked ticket can open. */
const MAX_BROWSERS = 20;

type SocketMeta = { role: "agent"; since: string } | { role: "browser"; tag: string; userId: string };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export class CommanderRelay {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    // Answered by the runtime itself: keepalives never wake (or bill) the object.
    const Pair = (globalThis as { WebSocketRequestResponsePair?: new (req: string, res: string) => unknown })
      .WebSocketRequestResponsePair;
    if (Pair) state.setWebSocketAutoResponse(new Pair("ping", "pong") as never);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/status") return json(200, this.status());
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return json(426, { error: "upgrade_required" });
    if (url.pathname === "/ws/agent") return this.acceptAgent();
    if (url.pathname === "/ws/browser") return this.acceptBrowser(request, url);
    return json(404, { error: "not_found" });
  }

  status(): { agentOnline: boolean; agentSince: string | null; browsers: number } {
    const agent = this.state.getWebSockets(AGENT_TAG)[0];
    const meta = agent ? (agent.deserializeAttachment() as SocketMeta | null) : null;
    return {
      agentOnline: Boolean(agent),
      agentSince: meta && meta.role === "agent" ? meta.since : null,
      browsers: this.browsers().length,
    };
  }

  private acceptAgent(): Response {
    // One agent at a time: a reconnect (or a second PC) replaces the old link rather than
    // leaving two agents racing to answer the same request.
    for (const old of this.state.getWebSockets(AGENT_TAG)) {
      try {
        old.close(4000, "replaced");
      } catch {
        /* already closing */
      }
    }
    const pair = new WebSocketPair();
    const server = pair[1] as unknown as CfWebSocket;
    this.state.acceptWebSocket(server, [AGENT_TAG]);
    server.serializeAttachment({ role: "agent", since: new Date().toISOString() } satisfies SocketMeta);
    this.broadcast({ t: "agent", online: true });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private async acceptBrowser(request: Request, url: URL): Promise<Response> {
    if (!originAllowed(request.headers.get("Origin"), this.env.RELAY_ALLOWED_ORIGINS)) {
      return json(403, { error: "origin_forbidden" });
    }
    const secret = this.env.RELAY_TICKET_SECRET;
    if (!secret) return json(503, { error: "relay_not_configured" });
    const ticket = url.searchParams.get("ticket");
    const claims = ticket ? await verifyTicket(secret, ticket) : null;
    if (!claims) return json(401, { error: "ticket_invalid" });
    if (this.browsers().length >= MAX_BROWSERS) return json(429, { error: "too_many_connections" });

    const tag = `b${crypto.randomUUID().replace(/-/g, "")}`;
    const pair = new WebSocketPair();
    const server = pair[1] as unknown as CfWebSocket;
    this.state.acceptWebSocket(server, [tag]);
    server.serializeAttachment({ role: "browser", tag, userId: claims.userId } satisfies SocketMeta);
    server.send(JSON.stringify({ t: "agent", online: this.state.getWebSockets(AGENT_TAG).length > 0 }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: CfWebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    const meta = ws.deserializeAttachment() as SocketMeta | null;
    if (!meta) return;
    if (meta.role === "agent") {
      const routed = routeAgentFrame(message);
      if (!routed) return;
      const browser = this.state.getWebSockets(routed.tag)[0];
      if (!browser) {
        // The tab is gone; let the agent stop any stream it still runs for it.
        this.sendToAgent({ t: "gone", tag: routed.tag });
        return;
      }
      safeSend(browser, routed.out);
      return;
    }

    const frame = parseBrowserFrame(message);
    if (!frame) {
      safeSend(ws, JSON.stringify({ t: "error", message: "invalid frame" }));
      return;
    }
    const scoped = { ...frame, id: scopeId(meta.tag, frame.id) };
    if (this.sendToAgent(scoped)) return;
    // No agent: answer locally so the UI shows "offline" instead of hanging.
    if (frame.t === "req") {
      safeSend(ws, JSON.stringify({ t: "res", id: frame.id, status: 503, body: JSON.stringify({ error: "agent_offline" }) }));
    } else if (frame.t === "sub") {
      safeSend(ws, JSON.stringify({ t: "end", id: frame.id, error: "agent_offline" }));
    }
  }

  async webSocketClose(ws: CfWebSocket, code: number, reason: string): Promise<void> {
    this.onGone(ws);
    try {
      ws.close(code, reason);
    } catch {
      /* already closing */
    }
  }

  async webSocketError(ws: CfWebSocket): Promise<void> {
    this.onGone(ws);
    try {
      ws.close(1011, "error");
    } catch {
      /* already closing */
    }
  }

  private onGone(ws: CfWebSocket): void {
    const meta = ws.deserializeAttachment() as SocketMeta | null;
    if (!meta) return;
    if (meta.role === "browser") {
      this.sendToAgent({ t: "gone", tag: meta.tag });
      return;
    }
    // Only report offline when no replacement agent is already connected.
    const others = this.state.getWebSockets(AGENT_TAG).filter((s) => s !== ws);
    if (others.length === 0) this.broadcast({ t: "agent", online: false });
  }

  private browsers(): CfWebSocket[] {
    return this.state.getWebSockets().filter((s) => {
      const m = s.deserializeAttachment() as SocketMeta | null;
      return m?.role === "browser";
    });
  }

  private broadcast(frame: unknown): void {
    const data = JSON.stringify(frame);
    for (const b of this.browsers()) safeSend(b, data);
  }

  private sendToAgent(frame: unknown): boolean {
    const agent = this.state.getWebSockets(AGENT_TAG)[0];
    if (!agent) return false;
    return safeSend(agent, JSON.stringify(frame));
  }
}

function safeSend(ws: CfWebSocket, data: string): boolean {
  try {
    ws.send(data);
    return true;
  } catch {
    return false;
  }
}
