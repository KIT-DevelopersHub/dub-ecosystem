// gantt-service Worker entry: HTTP (Hono app) + Queue consumer (cache purge) + the
// realtime WS upgrade (DO-direct). The `as never` bridges reconcile Hono's Fetch-standard
// types with @cloudflare/workers-types at the runtime boundary only.
//
// Realtime is DO-direct (gateway-bypassing): browsers open wss://<worker>/ws/:eventId
// straight to the GanttRoom DO, which is the SOLE verifier (HMAC ticket + Origin — no
// header trust). This needs the worker's workers.dev subdomain enabled (reachable from
// the public internet). The HTTP API, by contrast, trusts x-dub-user-id, which the
// api-gateway sets AFTER verifying the session — safe only over the private service
// binding. Service-binding calls arrive with host "svc" (api-gateway forwardRequest +
// @dub/http createServiceClient both use https://svc/…); a public workers.dev request
// carries the real subdomain host, which cannot be forged to "svc". So we gate the
// header-trusting API to service-binding callers only — otherwise enabling the subdomain
// for /ws would let anyone spoof x-dub-user-id. /health stays public for uptime probes.
import type { ExportedHandler, MessageBatch, Request as CfRequest } from "@cloudflare/workers-types";
import type { DubEventEnvelope } from "@dub/events";
import type { gantt } from "@dub/types";
import type { Env } from "./env";
import { createApp } from "./app";
import { buildQueueConsumer } from "./queue";
import { DEMO_PAGE_HTML } from "./demo-page";
import { signWsTicket, ticketExpiryMs, buildDoUrl } from "./wsticket";

// Dev-only fallback secret (matches app.ts). The demo Worker sets WS_TICKET_SECRET as a var.
const DEV_WS_SECRET = "dev-insecure-ws-ticket-secret";
const DEFAULT_DO_URL_BASE = "wss://dub-gantt-service.developershub-site.workers.dev/ws/:id";

const app = createApp();

/** Forward a WS upgrade straight to the event's GanttRoom DO (stub = getByName(eventId)),
 *  which verifies the ticket + Origin and accepts a hibernatable socket. */
function routeWebSocket(request: Request, env: Env, url: URL): Response {
  if (!env.GANTT_ROOM) return new Response("realtime unavailable", { status: 503 });
  const match = url.pathname.match(/^\/ws\/([^/]+)$/);
  if (!match) return new Response("not found", { status: 404 });
  const eventId = decodeURIComponent(match[1]!);
  const stub = env.GANTT_ROOM.getByName(eventId);
  return stub.fetch(request as unknown as CfRequest) as unknown as Response;
}

/** DEV/DEMO-ONLY: the self-contained 2-tab presence demo page. */
function demoPageResponse(): Response {
  return new Response(DEMO_PAGE_HTML, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/** DEV/DEMO-ONLY: mint a ws-ticket WITHOUT auth (gated by GANTT_RT_DEV_TICKET) so the
 *  self-contained demo can connect to the real DO with no gateway/auth/DB stack. The
 *  demo-supplied displayName is signed into the ticket so the DO can relay real names. */
async function demoWsTicket(env: Env, url: URL): Promise<Response> {
  const eventId = url.searchParams.get("eventId");
  const userId = url.searchParams.get("userId");
  const displayName = url.searchParams.get("displayName") ?? undefined;
  if (!eventId || !userId) {
    return new Response(JSON.stringify({ error: { code: "GANTT_DEMO_TICKET_MISSING_PARAMS" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const secret = env.WS_TICKET_SECRET ?? DEV_WS_SECRET;
  const base = env.GANTT_RT_DO_URL_BASE ?? DEFAULT_DO_URL_BASE;
  const expEpochMs = ticketExpiryMs(Date.now());
  const ticket = await signWsTicket(secret, {
    eventId,
    userId,
    expEpochMs,
    ...(displayName ? { displayName } : {}),
  });
  const res: gantt.GanttWsTicketResponse = {
    ticket,
    doUrl: buildDoUrl(base, eventId),
    expiresAt: new Date(expEpochMs).toISOString(),
    self: { userId },
  };
  return new Response(JSON.stringify(res), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const handler: ExportedHandler<Env> = {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Realtime WS upgrade → straight to the DO (public subdomain path).
    if (url.pathname.startsWith("/ws/") && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return routeWebSocket(request as unknown as Request, env, url) as never;
    }
    // DEV/DEMO-ONLY surfaces (never enabled in prod/staging): the presence demo page and
    // its unauthenticated ws-ticket issuer. Gated by GANTT_RT_DEV_TICKET so the header-
    // trusting API guard below is never relaxed in real environments.
    if (env.GANTT_RT_DEV_TICKET === "1") {
      if (url.pathname === "/" || url.pathname === "/demo") return demoPageResponse() as never;
      if (url.pathname === "/demo/ws-ticket") return demoWsTicket(env, url) as never;
    }
    // Header-trusting HTTP API is gated to service-binding callers (host "svc") only.
    // /health stays public; /ws already handled above. A public workers.dev request to
    // any business route 404s so x-dub-user-id can never be spoofed over the subdomain.
    const viaServiceBinding = url.hostname === "svc";
    if (!viaServiceBinding && url.pathname !== "/health" && !url.pathname.startsWith("/ws/")) {
      return new Response("not found", { status: 404 }) as never;
    }
    return app.fetch(request as never, env, ctx as never) as never;
  },
  async queue(batch, env) {
    await buildQueueConsumer(env)(batch as unknown as MessageBatch<DubEventEnvelope>, env);
  },
};

export default handler;
export type { Env } from "./env";
export { createApp } from "./app";
export { buildGanttChartDTO, progressOf } from "./dto";
export { GanttRoom } from "./gantt-room-do";
export { signWsTicket, verifyWsTicket, ticketExpiryMs, buildDoUrl } from "./wsticket";
export { NoopRealtimePublisher, DoRealtimePublisher, buildRealtime } from "./realtime";
