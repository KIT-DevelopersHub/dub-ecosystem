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
import type { Env } from "./env";
import { createApp } from "./app";
import { buildQueueConsumer } from "./queue";

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

const handler: ExportedHandler<Env> = {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Realtime WS upgrade → straight to the DO (public subdomain path).
    if (url.pathname.startsWith("/ws/") && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return routeWebSocket(request as unknown as Request, env, url) as never;
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
