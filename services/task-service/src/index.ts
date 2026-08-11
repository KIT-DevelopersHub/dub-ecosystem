// Cloudflare Worker entry. One physical Worker per service (theme7): HTTP fetch,
// Queue consumer, and cron scheduled handler are all rebuilt per invocation from
// bindings (buildDeps is cheap and keeps the isolate free of shared mutable state).
import type { ExecutionContext, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import type { DubEventEnvelope } from "@dub/events";
import { buildApp } from "./app";
import { buildDeps } from "./deps";
import { buildQueueHandler } from "./consumer";
import { runDueSoonScan } from "./scheduled";
import type { Env } from "./env";

export type { Env } from "./env";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const app = buildApp(buildDeps(env));
    return app.fetch(request);
  },

  async queue(batch: MessageBatch<DubEventEnvelope>, env: Env, _ctx: ExecutionContext): Promise<void> {
    await buildQueueHandler(buildDeps(env))(batch, env);
  },

  // Business cron only: the due-soon scan. The free-tier outbox drain was REMOVED from
  // here — the freeq outbox is now drained centrally by the standalone freeq-drain worker
  // (single aggregated cron). This service keeps its own business cron (due-soon scan).
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runDueSoonScan(buildDeps(env));
  },
};
