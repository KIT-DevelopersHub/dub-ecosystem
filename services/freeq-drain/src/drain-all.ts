// One aggregated drain pass over every bound freeq outbox D1. Reuses @dub/freeq's drain()
// (which owns claim/backoff/failed bookkeeping) with the shared topic-aware deliver.
//
// - batchSize 25: bounded work per DB per tick.
// - maxAttempts 16 (FINITE): a row that cannot be delivered — a topic with no live route
//   (deploy.job), or a consumer down past the whole backoff ladder (~hours) — eventually
//   reaches the terminal `failed` state instead of being re-UPDATEd forever. An UNBOUNDED
//   maxAttempts was the write-amplification bug: a permanently-deferred row (e.g. the
//   high-fan-out evt.notification backlog before its route existed) is re-claimed and
//   re-written on every tick for eternity. `failed` is retained (never deleted by the
//   drain) and only removed by the retention job (pruneAll), so nothing is silently lost;
//   an operator can inspect / requeue a failed row within its retention window.
// - best-effort per DB: one DB's SQL error is captured and does NOT abort the other DBs
//   (a broken auth-outbox must not stop dub-core from draining).
import type { D1Database } from "@cloudflare/workers-types";
import { drain, pruneOutbox, type DrainResult, type PruneOptions } from "@dub/freeq";
import type { Env } from "./env";
import { OUTBOX_DB_BINDINGS, type OutboxDbBinding } from "./env";
import { makeDeliver } from "./routing";

// Finite maxAttempts (8..16 window). 16 * a 1h-capped exponential backoff gives a
// multi-hour delivery window before a row is declared terminally failed.
export const DRAIN_OPTS = { batchSize: 25, maxAttempts: 16 } as const;

export type DrainAllEntry = ({ ok: true } & DrainResult) | { ok: false; error: string };
export type DrainAllResult = Partial<Record<OutboxDbBinding, DrainAllEntry>>;

/**
 * Drain each bound outbox D1 in sequence with the single shared deliver. A missing
 * binding is skipped; a per-DB failure is recorded and swallowed so the remaining DBs
 * still drain. Returns a per-DB summary (for the scheduled-handler log).
 */
export async function drainAll(env: Env): Promise<DrainAllResult> {
  const deliver = makeDeliver(env);
  const out: DrainAllResult = {};
  for (const name of OUTBOX_DB_BINDINGS) {
    const db = env[name] as D1Database | undefined;
    if (!db) continue; // binding not present in this deploy: nothing to drain
    try {
      const res = await drain(db, deliver, DRAIN_OPTS);
      out[name] = { ok: true, ...res };
    } catch (err) {
      out[name] = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return out;
}

export type PruneAllEntry = { ok: true; deleted: number } | { ok: false; error: string };
export type PruneAllResult = Partial<Record<OutboxDbBinding, PruneAllEntry>>;

/**
 * Retention pass: delete terminal (`done` / `failed`) rows older than their window from
 * every bound outbox D1. Best-effort per DB (a broken DB is recorded, never aborts the
 * rest) and never touches `pending` rows, so no undelivered message is ever lost. Kept
 * separate from drainAll so the DO alarm can run it on a slower cadence than the drain
 * (see drain-do.ts) — pruning every tick is unnecessary write traffic. NOTE: DB_CORE /
 * DB_DRIVE / DB_MOBILE all resolve to the same physical dub-core D1, so the DELETE runs
 * more than once against it; that is harmless and idempotent (later passes match 0 rows).
 */
export async function pruneAll(env: Env, opts?: PruneOptions): Promise<PruneAllResult> {
  const out: PruneAllResult = {};
  for (const name of OUTBOX_DB_BINDINGS) {
    const db = env[name] as D1Database | undefined;
    if (!db) continue;
    try {
      const { deleted } = await pruneOutbox(db, opts);
      out[name] = { ok: true, deleted };
    } catch (err) {
      out[name] = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return out;
}
