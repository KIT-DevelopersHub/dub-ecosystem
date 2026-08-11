// Cloudflare Worker entry. One physical Worker per unit (theme7). The app is
// rebuilt per request from bindings (buildDeps is cheap, keeps the isolate free of
// shared mutable state).
// - queue():     PAID plan only — drains dub-q-evt-mobile-bff into the change_log.
// - scheduled(): FREE plan Cron — drains the @dub/freeq audit outbox to audit-log.
// The two lanes never both run in one deploy: paid wrangler.toml wires the Queue
// (no [triggers]); free wrangler.free.toml wires the Cron (no Queue). The change_log
// free-tier lane arrives over HTTP (POST /internal/events-async), not the queue.
import type { ExecutionContext, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import type { DubEventEnvelope } from "@dub/events";
import { buildApp } from "./app";
import { buildDeps } from "./deps";
import { mobileQueueHandler } from "./queue";
import { runOutboxDrain } from "./drain";
import type { Env } from "./env";

export type { Env } from "./env";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const app = buildApp(buildDeps(env));
    return app.fetch(request);
  },
  async queue(batch: MessageBatch<DubEventEnvelope>, env: Env): Promise<void> {
    await mobileQueueHandler(batch, env);
  },
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runOutboxDrain(env);
  },
};
