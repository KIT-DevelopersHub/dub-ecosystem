// Forward-only apply pipeline over the aggregated migrations. Uses @dub/db's ledger
// (dub_migrations) + content hash for idempotency and drift detection. Each migration's
// full `up` is executed via D1Database.exec so multi-statement DDL and TRIGGER bodies
// (which contain inner ';') apply atomically — @dub/db's applyMigrations splits on ';'
// and cannot handle triggers, so this unit owns its own executor.
import type { D1Database } from "@cloudflare/workers-types";
import { DubError } from "@dub/errors";
import { ensureLedger, hashMigration, nowIso, type Migration } from "@dub/db";
import { collectMigrations } from "./collect";

const SELECT_HASH = "SELECT hash FROM dub_migrations WHERE namespace = ? AND id = ?";
const INSERT_LEDGER = "INSERT INTO dub_migrations (namespace, id, hash, applied_at) VALUES (?, ?, ?, ?)";

export interface ApplyResult {
  applied: string[]; // "<ns>/<id>"
  skipped: string[]; // already applied, hash matches
}

/** Apply all pending aggregated migrations in deterministic order. Idempotent:
 *  re-running skips everything. Throws DB_MIGRATION_DRIFT on content divergence and
 *  DB_MIGRATION_FAILED on a SQL error. */
export async function applyAll(db: D1Database, migrations: readonly Migration[] = collectMigrations()): Promise<ApplyResult> {
  await ensureLedger(db);
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const m of migrations) {
    const key = `${m.namespace}/${m.id}`;
    const hash = hashMigration(m.up);
    const existing = await db.prepare(SELECT_HASH).bind(m.namespace, m.id).first<{ hash: string }>();

    if (existing) {
      if (existing.hash !== hash) {
        throw new DubError("DB_MIGRATION_DRIFT", `${key}: applied content differs from ledger`, { status: 500 });
      }
      skipped.push(key);
      continue;
    }

    try {
      // Whole migration in one exec: multi-statement + TRIGGER bodies apply atomically.
      await db.exec(m.up);
      await db.prepare(INSERT_LEDGER).bind(m.namespace, m.id, hash, nowIso()).run();
      applied.push(key);
    } catch (cause) {
      throw new DubError("DB_MIGRATION_FAILED", `${key}: ${cause instanceof Error ? cause.message : String(cause)}`, {
        status: 500,
        cause,
      });
    }
  }

  return { applied, skipped };
}
