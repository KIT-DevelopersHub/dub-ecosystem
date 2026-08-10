// "@dub/freeq" drain — the self-built free-queue worker. Mutation endpoints append
// audit rows to mail_outbox (D1) inside the request; here we claim due rows and publish
// them to the EXISTING AUDIT_QUEUE. This keeps async fan-out off the request path
// WITHOUT provisioning a new (paid) Cloudflare Queue. Run by the daily cron and reachable
// via POST /internal/outbox/drain for ops/tests.
import { createDbClient, type DbClient, nowIso } from "@dub/db";
import { publishAudit } from "@dub/events";
import { consoleSink } from "@dub/observability";
import type { auditLog } from "@dub/types";
import { SERVICE_NAME } from "./config";
import type { Env } from "./env";
import { bumpOutboxFailure, claimOutboxPending, markOutboxDone } from "./ops-repo";
import type { AuditEnv } from "./types";

export const OUTBOX_DRAIN_BATCH = 50;
export const OUTBOX_MAX_ATTEMPTS = 5;
const OUTBOX_BASE_BACKOFF_MS = 60_000; // 1min, doubling per attempt

export interface DrainResult {
  claimed: number;
  published: number;
  failed: number;
}

/** Drain up to `limit` due outbox rows to their sink. Never throws — a bad row backs off. */
export async function drainOutbox(db: DbClient, audit: AuditEnv, opts: { now?: number; limit?: number } = {}): Promise<DrainResult> {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? OUTBOX_DRAIN_BATCH;
  const rows = await claimOutboxPending(db, new Date(now).toISOString(), limit);
  let published = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      if (row.kind === "audit") {
        const input = JSON.parse(row.payload_json) as auditLog.AuditRecordInput;
        await publishAudit(audit, input);
      } else {
        throw new Error(`unknown outbox kind: ${row.kind}`);
      }
      await markOutboxDone(db, row.id);
      published++;
    } catch (err) {
      failed++;
      const backoff = OUTBOX_BASE_BACKOFF_MS * 2 ** row.attempts;
      const nextAttemptAt = new Date(now + backoff).toISOString();
      const message = err instanceof Error ? err.message : String(err);
      await bumpOutboxFailure(db, row, nextAttemptAt, message, OUTBOX_MAX_ATTEMPTS);
      consoleSink({ level: "warn", message: "mail-gateway outbox drain: row failed", service: SERVICE_NAME, fields: { id: row.id, attempts: row.attempts + 1, error: message } });
    }
  }
  return { claimed: rows.length, published, failed };
}

/** Cron/entry convenience: build the namespace DB client from Env and drain. */
export async function runOutboxDrain(env: Env, now: number = Date.now()): Promise<DrainResult> {
  const db = createDbClient(env.DB, { namespace: "mail" });
  const result = await drainOutbox(db, { AUDIT_QUEUE: env.AUDIT_QUEUE }, { now });
  consoleSink({ level: "info", message: "mail-gateway outbox drain finished", service: SERVICE_NAME, fields: { ...result, at: nowIso() } });
  return result;
}
