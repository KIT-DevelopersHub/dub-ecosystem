// @dub/freeq outbox — a free-tier replacement for a single Cloudflare Queue.
//
// Producers INSERT one row per message (transactional with their own writes if they
// wish). A drain — run from a free Cron Trigger or a Durable Object alarm — claims due
// pending rows, hands each to a transport-agnostic `deliver` callback, then marks the
// row done / reschedules it with exponential backoff / gives up into a terminal
// `failed` state after maxAttempts. Delivery is AT-LEAST-ONCE: a message may be
// redelivered if `deliver` succeeds but the status write is lost, so consumers MUST be
// idempotent (the row id is a stable idempotency key). Rows are never deleted by the
// drain, so an audit event enqueued here can never be lost — it stays in the table as
// pending, failed, or done until a retention job prunes done rows.
import type { D1Database } from "@cloudflare/workers-types";
import { ulid, nowIso } from "@dub/db";
import { backoffMs, type BackoffOptions } from "./backoff";

export type OutboxStatus = "pending" | "done" | "failed";

export interface OutboxRow {
  id: string;
  topic: string;
  payload: string; // JSON-encoded message body
  status: OutboxStatus;
  attempts: number;
  next_attempt_at: string; // ISO8601; the row is due when this <= now
  created_at: string; // ISO8601
  last_error: string | null;
}

export const OUTBOX_TABLE = "freeq_outbox";

// Table name is deliberately un-namespaced (`freeq_`) so it never collides with a
// @dub/db business namespace; this package talks to D1 directly, not via the
// namespace-scoped DbClient, because the outbox is infra plumbing, not domain data.
export const OUTBOX_DDL = `CREATE TABLE IF NOT EXISTS freeq_outbox (
  id              TEXT PRIMARY KEY,
  topic           TEXT NOT NULL,
  payload         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  last_error      TEXT
);
CREATE INDEX IF NOT EXISTS freeq_outbox_ready ON freeq_outbox (status, next_attempt_at);`;

export interface EnqueueOptions {
  id?: string; // supply for idempotent enqueue (INSERT OR IGNORE dedupes on id)
  now?: () => number; // clock injection (tests)
}

/**
 * Producer: append one message. Returns the row id (a fresh ULID unless `id` is given).
 * INSERT OR IGNORE makes a retried enqueue with the same id a no-op (idempotent).
 */
export async function enqueue(
  db: D1Database,
  topic: string,
  payload: unknown,
  opts: EnqueueOptions = {},
): Promise<string> {
  const now = opts.now?.() ?? Date.now();
  const iso = new Date(now).toISOString();
  const id = opts.id ?? ulid(now);
  await db
    .prepare(
      `INSERT OR IGNORE INTO ${OUTBOX_TABLE}
         (id, topic, payload, status, attempts, next_attempt_at, created_at, last_error)
       VALUES (?, ?, ?, 'pending', 0, ?, ?, NULL)`,
    )
    .bind(id, topic, JSON.stringify(payload ?? null), iso, iso)
    .run();
  return id;
}

/** The message handed to a consumer. `payload` is the JSON-decoded body. */
export interface OutboxMessage {
  id: string;
  topic: string;
  payload: unknown;
  attempts: number; // this delivery's attempt number (1 = first)
}

/** Transport-agnostic delivery. Throw to signal failure (row is retried / failed). */
export type Deliver = (msg: OutboxMessage) => Promise<void>;

export interface DrainOptions extends BackoffOptions {
  batchSize?: number; // max rows claimed per drain (default 25)
  maxAttempts?: number; // attempts before a row is marked failed (default 8)
  now?: () => number; // clock injection (tests)
}

export interface DrainResult {
  claimed: number;
  delivered: number;
  retried: number;
  failed: number;
}

const DEFAULT_BATCH = 25;
const DEFAULT_MAX_ATTEMPTS = 8;

/**
 * Drain: deliver all due pending rows once. Meant to be called from a Cron Trigger
 * (or DO alarm) on a fixed cadence. Each row is delivered at most once per drain;
 * on failure it is rescheduled with exponential backoff, and after `maxAttempts`
 * cumulative failures it moves to the terminal `failed` state (retained, not deleted).
 */
export async function drain(db: D1Database, deliver: Deliver, opts: DrainOptions = {}): Promise<DrainResult> {
  const now = opts.now?.() ?? Date.now();
  const nowStr = new Date(now).toISOString();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const res = await db
    .prepare(
      `SELECT id, topic, payload, status, attempts, next_attempt_at, created_at, last_error
         FROM ${OUTBOX_TABLE}
        WHERE status = 'pending' AND next_attempt_at <= ?
        ORDER BY next_attempt_at ASC
        LIMIT ?`,
    )
    .bind(nowStr, batchSize)
    .all<OutboxRow>();
  const rows = res.results ?? [];

  const out: DrainResult = { claimed: rows.length, delivered: 0, retried: 0, failed: 0 };

  for (const row of rows) {
    const attempts = row.attempts + 1;
    try {
      await deliver({ id: row.id, topic: row.topic, payload: JSON.parse(row.payload), attempts });
      await db
        .prepare(`UPDATE ${OUTBOX_TABLE} SET status = 'done', attempts = ?, last_error = NULL WHERE id = ?`)
        .bind(attempts, row.id)
        .run();
      out.delivered++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempts >= maxAttempts) {
        await db
          .prepare(`UPDATE ${OUTBOX_TABLE} SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?`)
          .bind(attempts, message, row.id)
          .run();
        out.failed++;
      } else {
        const nextAt = new Date(now + backoffMs(attempts, opts)).toISOString();
        await db
          .prepare(`UPDATE ${OUTBOX_TABLE} SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`)
          .bind(attempts, nextAt, message, row.id)
          .run();
        out.retried++;
      }
    }
  }
  return out;
}

/** Idempotently create the outbox table (call once at deploy/migration time). */
export async function ensureOutbox(db: D1Database): Promise<void> {
  for (const stmt of OUTBOX_DDL.split(";").map((s) => s.trim()).filter(Boolean)) {
    await db.prepare(stmt).run();
  }
}

/** Small helper for callers that want the canonical timestamp mint. */
export { nowIso };
