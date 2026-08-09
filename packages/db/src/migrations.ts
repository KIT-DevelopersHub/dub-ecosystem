// Forward-only migration runner + ledger. Physical files live in
// infra/d1/migrations/<ns>/ (#28 owns/applies); this module is the runner + ledger.
import type { D1Database } from "@cloudflare/workers-types";
import { DubError } from "@dub/errors";
import { NAMESPACES, type Namespace } from "./namespaces";
import { nowIso } from "./ids";

export interface Migration {
  id: string; // "0001_create_identity_users" (4-digit seq + snake); "0001_init" allowed for first
  namespace: Namespace; // all statements must stay in this namespace
  up: string; // forward-only SQL (multiple statements allowed)
}

export interface MigrationResult {
  namespace: Namespace;
  id: string;
  status: "applied" | "skipped" | "failed";
  error?: string;
}

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS dub_migrations (
  namespace  TEXT NOT NULL,
  id         TEXT NOT NULL,
  hash       TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (namespace, id)
);`;

const SELECT_HASH = "SELECT hash FROM dub_migrations WHERE namespace = ? AND id = ?";
const INSERT_LEDGER = "INSERT INTO dub_migrations (namespace, id, hash, applied_at) VALUES (?, ?, ?, ?)";

/** FNV-1a 32-bit hex; content-hash for drift detection. */
export function hashMigration(up: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < up.length; i++) {
    h ^= up.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export async function ensureLedger(d1: D1Database): Promise<void> {
  await d1.prepare(LEDGER_DDL).run();
}

function splitStatements(up: string): string[] {
  return up
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Deterministic order: NAMESPACES declaration order, then id ascending. */
function orderMigrations(migrations: readonly Migration[]): Migration[] {
  const nsIndex = (ns: Namespace): number => NAMESPACES.indexOf(ns);
  return [...migrations].sort((a, b) => {
    const byNs = nsIndex(a.namespace) - nsIndex(b.namespace);
    return byNs !== 0 ? byNs : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Idempotent: consults the ledger, verifies content hash of already-applied
 * migrations (drift detection), applies pending ones forward-only. On failure the
 * failed migration is reported and subsequent ones are not applied.
 */
export async function applyMigrations(
  d1: D1Database,
  migrations: readonly Migration[],
): Promise<MigrationResult[]> {
  await ensureLedger(d1);
  const ordered = orderMigrations(migrations);
  const results: MigrationResult[] = [];
  let halted = false;

  for (const m of ordered) {
    if (halted) {
      results.push({ namespace: m.namespace, id: m.id, status: "skipped" });
      continue;
    }
    const hash = hashMigration(m.up);
    const existing = await d1.prepare(SELECT_HASH).bind(m.namespace, m.id).first<{ hash: string }>();

    if (existing) {
      if (existing.hash !== hash) {
        halted = true;
        results.push({
          namespace: m.namespace,
          id: m.id,
          status: "failed",
          error: "DB_MIGRATION_DRIFT: applied content differs from ledger",
        });
      } else {
        results.push({ namespace: m.namespace, id: m.id, status: "skipped" });
      }
      continue;
    }

    try {
      for (const stmt of splitStatements(m.up)) {
        await d1.prepare(stmt).run();
      }
      await d1.prepare(INSERT_LEDGER).bind(m.namespace, m.id, hash, nowIso()).run();
      results.push({ namespace: m.namespace, id: m.id, status: "applied" });
    } catch (cause) {
      halted = true;
      results.push({
        namespace: m.namespace,
        id: m.id,
        status: "failed",
        error: `DB_MIGRATION_FAILED: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
  }
  return results;
}

/** Throw if any migration failed (for CI gates). */
export function assertAllApplied(results: readonly MigrationResult[]): void {
  const failed = results.filter((r) => r.status === "failed");
  if (failed.length > 0) {
    throw new DubError("DB_MIGRATION_FAILED", `${failed.length} migration(s) failed`, {
      status: 500,
      details: failed,
    });
  }
}
