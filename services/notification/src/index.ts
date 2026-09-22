// notification Worker entry: HTTP (fetch), Queue consumer (dub-q-evt-notification),
// scheduled Cron (daily retention purge). Deploy is out of scope for this unit.
import type { ExecutionContext, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import type { DubEventEnvelope } from "@dub/events";
import { createApp } from "./app";
import { consumeEventQueue } from "./queue";
import { runRetentionPurge } from "./scheduled";
import type { Env } from "./env";

const app = createApp();

// DO-direct realtime: browsers open wss://<this worker>/ws/:userId straight to the
// per-user InboxRoom DO (HMAC ticket + Origin verified there — no header trust). Mirrors
// chat-service. Needs the worker's workers.dev subdomain enabled (wrangler.free.toml).
function routeWebSocket(request: Request, env: Env, url: URL): Response {
  if (!env.INBOX_ROOM) return new Response("realtime unavailable", { status: 503 });
  const match = url.pathname.match(/^\/ws\/([^/]+)$/);
  if (!match) return new Response("not found", { status: 404 });
  const userId = decodeURIComponent(match[1]!);
  const stub = env.INBOX_ROOM.getByName(userId);
  return stub.fetch(request as unknown as Request) as unknown as Response;
}

// Plain module handler (not typed as ExportedHandler to avoid the workers-types vs
// undici Response brand clash under the root tsconfig which omits workers-types globals).
const handler = {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);
    // Realtime WS upgrade is public (DO verifies ticket + Origin) and gateway-bypassing.
    if (url.pathname.startsWith("/ws/") && req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return routeWebSocket(req, env, url);
    }
    // The HTTP API trusts x-dub-user-id, which the api-gateway sets AFTER verifying the
    // session — safe ONLY over the private service binding (host "svc"). With workers.dev
    // enabled for /ws, gate the header-trusting API to service-binding callers so a public
    // request cannot spoof x-dub-user-id. /internal/health stays public for uptime probes.
    const viaServiceBinding = url.hostname === "svc";
    if (!viaServiceBinding && url.pathname !== "/internal/health") {
      return new Response("not found", { status: 404 });
    }
    return app.fetch(req, env, ctx as unknown as never);
  },

  queue(batch: MessageBatch<DubEventEnvelope>, env: Env): Promise<void> {
    return consumeEventQueue(batch, env);
  },

  // Daily Cron: retention purge only. The free-tier audit outbox drain was REMOVED from
  // here — the freeq outbox is now drained centrally by the standalone freeq-drain worker
  // (single aggregated cron). This service keeps its own business cron (retention purge).
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await runRetentionPurge(env);
  },
};

export default handler;
export { createApp };
export { InboxRoom } from "./inbox-room-do";
export { signWsTicket, verifyWsTicket, ticketExpiryMs } from "./wsticket";
export type { Env };
