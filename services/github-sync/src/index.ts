// github-sync Worker entrypoint: HTTP (Hono) + two Queue consumers + reconcile cron.
// The reconcile pass is driven by the Cron Trigger (paid wrangler.toml) via the scheduled
// handler below, OR by the GithubReconcileDO alarm (free plan, wrangler.free.toml — no cron
// slot consumed). The reconcile body itself lives in ./reconcile so both paths share it.
import type {
  ExecutionContext,
  MessageBatch,
  ScheduledController,
} from "@cloudflare/workers-types";
import type { DubEventEnvelope, WebhookEventEnvelopeV1 } from "@dub/events";
import type { Env } from "./env";
import { WH_GITHUB_QUEUE, EVT_GITHUB_SYNC_QUEUE } from "./env";
import { buildRuntime } from "./deps";
import { createApp } from "./app";
import { handleWebhookBatch, buildDomainEventHandler } from "./queue";
import { runScheduled } from "./reconcile";

// SQLite-backed DO that drives the free-plan reconcile via an alarm (no cron slot). Bound
// only in wrangler.free.toml; harmlessly unused when deploying the paid wrangler.toml.
export { GithubReconcileDO } from "./reconcile-do";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const rt = buildRuntime(env);
    const app = createApp({
      auth: rt.auth,
      service: rt.service,
      publisher: rt.publisher,
      now: rt.now,
      queue: { engine: rt.engine, processed: rt.stores.processed, webhookRaw: env.WEBHOOK_RAW },
    });
    return app.fetch(request, env as unknown as Record<string, unknown>);
  },

  async queue(
    batch: MessageBatch<WebhookEventEnvelopeV1 | DubEventEnvelope>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const rt = buildRuntime(env);
    const qdeps = { engine: rt.engine, processed: rt.stores.processed, webhookRaw: env.WEBHOOK_RAW };
    if (batch.queue === WH_GITHUB_QUEUE) {
      await handleWebhookBatch(batch as MessageBatch<WebhookEventEnvelopeV1>, qdeps);
      return;
    }
    if (batch.queue === EVT_GITHUB_SYNC_QUEUE) {
      const handler = buildDomainEventHandler(qdeps);
      await handler(batch as MessageBatch<DubEventEnvelope>, env);
      return;
    }
    // Unknown queue: ack everything (forward-compat).
    for (const m of batch.messages) m.ack();
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env));
  },
};
