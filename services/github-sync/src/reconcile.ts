// The github-sync reconcile pass (+ idempotency purge). Extracted from index.ts so it can
// be driven by EITHER a Cron Trigger (paid wrangler.toml -> scheduled handler) OR the
// GithubReconcileDO alarm (free plan -> wrangler.free.toml, no cron slot consumed). The
// free-tier outbox drain was already removed from this path — the @dub/freeq outbox is
// drained centrally by the standalone freeq-drain worker; this is the business cron only.
import { emptyStats, type SyncRunRecord } from "./domain/types";
import type { Env } from "./env";
import { buildRuntime } from "./deps";

const PROCESSED_TTL_DAYS = 14;

export async function runScheduled(env: Env): Promise<void> {
  await runReconcileCron(env);
}

export async function runReconcileCron(env: Env): Promise<void> {
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
