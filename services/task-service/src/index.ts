// Cloudflare Worker entry. One physical Worker per service (theme7): HTTP fetch,
// Queue consumer, and cron scheduled handler are all rebuilt per invocation from
// bindings (buildDeps is cheap and keeps the isolate free of shared mutable state).
import type { ExecutionContext, MessageBatch, ScheduledController } from "@cloudflare/workers-types";
import type { DubEventEnvelope } from "@dub/events";
import { consoleSink } from "@dub/observability";
import { buildApp } from "./app";
import { buildDeps } from "./deps";
import { buildQueueHandler } from "./consumer";
import { runDueSoonScan } from "./scheduled";
import { runOutboxDrain } from "./drain";
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

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Free-tier outbox drain runs every tick (forwards audit rows to audit-log; defers
    // domain events). Best-effort: a drain hiccup must not abort the due-soon scan. On a
    // paid deploy (real Queues) the outbox is empty, so the drain is a cheap no-op.
    try {
      const result = await runOutboxDrain(env);
      consoleSink({ level: "info", message: "task-service outbox drained", service: "task-service", fields: { ...result } });
    } catch (err) {
      consoleSink({
        level: "error",
        message: "task-service outbox drain failed",
        service: "task-service",
        fields: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    await runDueSoonScan(buildDeps(env));
  },
};
