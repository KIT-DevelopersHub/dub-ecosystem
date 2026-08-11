// github-sync Worker entrypoint: HTTP (Hono) + two Queue consumers + reconcile cron.
import type {
  ExecutionContext,
  MessageBatch,
  ScheduledController,
} from "@cloudflare/workers-types";
import type { DubEventEnvelope, WebhookEventEnvelopeV1 } from "@dub/events";
import { consoleSink } from "@dub/observability";
import { emptyStats, type SyncRunRecord } from "./domain/types";
import type { Env } from "./env";
import { WH_GITHUB_QUEUE, EVT_GITHUB_SYNC_QUEUE } from "./env";
import { buildRuntime } from "./deps";
import { createApp } from "./app";
import { handleWebhookBatch, buildDomainEventHandler } from "./queue";
import { runOutboxDrain } from "./drain";

const PROCESSED_TTL_DAYS = 14;

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

async function runScheduled(env: Env): Promise<void> {
  // Free-tier outbox drain runs on every tick (forwards audit rows to audit-log; defers
  // domain events). Best-effort: a drain hiccup must not abort the reconcile. On a paid
  // deploy (real Queues) the outbox is empty, so the drain is a cheap no-op.
  try {
    const result = await runOutboxDrain(env);
    consoleSink({ level: "info", message: "github-sync outbox drained", service: "github-sync", fields: { ...result } });
  } catch (err) {
    consoleSink({
      level: "error",
      message: "github-sync outbox drain failed",
      service: "github-sync",
      fields: { error: err instanceof Error ? err.message : String(err) },
    });
  }
  await runReconcileCron(env);
}

async function runReconcileCron(env: Env): Promise<void> {
  const rt = buildRuntime(env);
  const requestId = rt.now() + "-cron";
  const run: SyncRunRecord = {
    id: `ghs_cron_${Date.now()}`,
    scope: "cron",
    repoId: null,
    status: "running",
    stats: emptyStats(),
    triggeredBy: null,
    startedAt: rt.now(),
    finishedAt: null,
    error: null,
    createdAt: rt.now(),
  };
  await rt.stores.runs.create(run);
  const stats = emptyStats();
  let failed = false;
  let cursor: string | null = null;
  do {
    const page = await rt.stores.repos.list({ enabled: true }, cursor, 200);
    for (const repo of page.items) {
      try {
        const s = await rt.engine.reconcileRepo(requestId, repo);
        stats.created += s.created;
        stats.updated += s.updated;
        stats.skipped += s.skipped;
        stats.conflicts += s.conflicts;
        stats.failed += s.failed;
      } catch {
        failed = true;
        stats.failed++;
      }
    }
    cursor = page.nextCursor;
  } while (cursor);

  await rt.stores.runs.update(run.id, {
    status: failed || stats.failed > 0 ? "partial_failed" : "succeeded",
    stats,
    finishedAt: rt.now(),
  });

  // Purge processed-event idempotency rows older than the TTL.
  const cutoff = new Date(Date.now() - PROCESSED_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await rt.stores.processed.purgeOlderThan(cutoff);
}
