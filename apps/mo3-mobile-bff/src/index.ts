// Cloudflare Worker entry. One physical Worker per unit (theme7). The app is
// rebuilt per request from bindings (buildDeps is cheap, keeps the isolate free of
// shared mutable state).
// - queue():     PAID plan only — drains dub-q-evt-mobile-bff into the change_log.
// The change_log free-tier lane arrives over HTTP (POST /internal/events-async), not the
// queue. The @dub/freeq audit outbox is drained by the standalone freeq-drain worker
// (single aggregated cron), so this Worker no longer runs its own scheduled() drain.
// src/drain.ts is retained as the topic->destination contract source (audit.record).
import type { ExecutionContext, MessageBatch } from "@cloudflare/workers-types";
import type { DubEventEnvelope } from "@dub/events";
import { buildApp } from "./app";
import { buildDeps } from "./deps";
import { mobileQueueHandler } from "./queue";
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
};
