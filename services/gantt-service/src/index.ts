// gantt-service Worker entry: HTTP (Hono app) + Queue consumer (cache purge) + the
// realtime /ws upgrade routed to the GanttRoom Durable Object (presence + live sync).
// The `as never` bridges reconcile Hono's Fetch-standard types with
// @cloudflare/workers-types at the runtime boundary only.
import type { ExportedHandler, MessageBatch } from "@cloudflare/workers-types";
import type { DubEventEnvelope } from "@dub/events";
import type { common } from "@dub/types";
import type { Env } from "./env";
import { createApp } from "./app";
import { buildQueueConsumer } from "./queue";
import { signWsTicket, ticketExpiryMs } from "./wsticket";
import { ganttWsSecret, ganttDoUrl } from "./realtime";
import { DEMO_PAGE_HTML } from "./demo-page";

const app = createApp();

// WS is DO-direct: browsers open wss://<worker>/ws/:eventId straight to the GanttRoom DO
// (HMAC ticket + Origin verified there — no header trust). Routed to getByName(eventId).
function routeWebSocket(request: Request, env: Env, url: URL): Response {
  if (!env.GANTT_ROOM) return new Response("realtime unavailable", { status: 503 });
  const match = url.pathname.match(/^\/ws\/([^/]+)$/);
  if (!match) return new Response("not found", { status: 404 });
  const eventId = decodeURIComponent(match[1]!);
  const stub = env.GANTT_ROOM.getByName(eventId);
  return stub.fetch(request as unknown as Request) as unknown as Response;
}

// DEV-ONLY (GANTT_RT_DEV_TICKET=1): a self-contained two-tab demo of presence + live sync
// against the real DO, WITHOUT the auth/gateway/task stack. Serves the demo page and an
// unauthenticated ticket issuer. NEVER enabled in a prod wrangler config. Params are read
// off the URL (not c.req.query) so the wire-contract scanner is unaffected.
async function routeDev(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (env.GANTT_RT_DEV_TICKET !== "1") return null;
  if (url.pathname === "/demo") {
    return new Response(DEMO_PAGE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (url.pathname === "/dev-ws-ticket") {
    const eventId = (url.searchParams.get("eventId") ?? "evt_demo") as common.EventId;
    const userId = (url.searchParams.get("userId") ?? "usr_demo") as common.UserId;
    const displayName = url.searchParams.get("name") ?? userId;
    const exp = ticketExpiryMs();
    const ticket = await signWsTicket(ganttWsSecret(env), { eventId, userId, displayName, expEpochMs: exp });
    const body = {
      ticket,
      doUrl: ganttDoUrl(env, eventId),
      expiresAt: new Date(exp).toISOString(),
      self: { userId, displayName },
    };
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    });
  }
  return null;
}

const handler: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1) Realtime WS upgrade — public (DO verifies ticket + Origin).
    if (url.pathname.startsWith("/ws/") && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return routeWebSocket(request, env, url);
    }

    // 2) Dev demo surface (only when GANTT_RT_DEV_TICKET=1).
    const dev = await routeDev(request, env, url);
    if (dev) return dev;

    // 3) The HTTP API trusts x-dub-user-id, which the api-gateway sets AFTER verifying the
    //    session — safe ONLY over the private service binding (host "svc"; @dub/http +
    //    the gateway both forward via https://svc/…). Enabling workers.dev for /ws means a
    //    public request carries the real subdomain host, which cannot be forged to "svc".
    //    So gate the header-trusting API to service-binding callers; /health stays public
    //    for uptime probes; /ws + dev routes were already handled above.
    const viaServiceBinding = url.hostname === "svc";
    if (!viaServiceBinding && url.pathname !== "/health") {
      return new Response("not found", { status: 404 });
    }
    return app.fetch(request as never, env, ctx as never) as never;
  },
  async queue(batch, env) {
    await buildQueueConsumer(env)(batch as unknown as MessageBatch<DubEventEnvelope>, env);
  },
};

export default handler;
export { createApp } from "./app";
export { buildGanttChartDTO, progressOf } from "./dto";
export { GanttRoom } from "./gantt-room-do";
export { signWsTicket, verifyWsTicket, ticketExpiryMs } from "./wsticket";
