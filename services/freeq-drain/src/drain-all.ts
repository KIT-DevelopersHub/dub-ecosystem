// One aggregated drain pass over every bound freeq outbox D1. Reuses @dub/freeq's drain()
// (which owns claim/backoff/failed bookkeeping) with the shared topic-aware deliver.
//
// - batchSize 25: bounded work per DB per tick.
// - maxAttempts MAX_SAFE_INTEGER: deferred rows (and a temporarily-down consumer) never
//   reach the terminal `failed` state — every record stays durable in D1 until it can
//   actually be delivered.
// - best-effort per DB: one DB's SQL error is captured and does NOT abort the other DBs
//   (a broken auth-outbox must not stop dub-core from draining).
import type { D1Database } from "@cloudflare/workers-types";
import { drain, type DrainResult } from "@dub/freeq";
import type { Env } from "./env";
import { OUTBOX_DB_BINDINGS, type OutboxDbBinding } from "./env";
import { makeDeliver } from "./routing";

const DRAIN_OPTS = { batchSize: 25, maxAttempts: Number.MAX_SAFE_INTEGER } as const;

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
