// Drift + presence verification. Compares each aggregated migration's current content
// hash against the dub_migrations ledger (drift), and every declared table against
// sqlite_master (missing). Used by `d1:verify` (CI) and acceptance test #4.
import type { D1Database } from "@cloudflare/workers-types";
import { ensureLedger, hashMigration, type Migration } from "@dub/db";
import { collectMigrations } from "./collect";

const CREATE_TABLE = /create\s+table(?:\s+if\s+not\s+exists)?\s+["'`]?([a-zA-Z_][a-zA-Z0-9_]*)/gi;

export interface VerifyResult {
  ok: boolean;
  missingTables: string[];
  drift: string[]; // "<ns>/<id>" whose file hash != ledger (or not applied)
}

/** Every table declared across the aggregated migrations (plus the meta ledger). */
export function declaredTables(migrations: readonly Migration[] = collectMigrations()): string[] {
  const tables = new Set<string>(["dub_migrations"]);
  for (const m of migrations) {
    CREATE_TABLE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CREATE_TABLE.exec(m.up)) !== null) {
      if (match[1]) tables.add(match[1]);
    }
  }
  return [...tables];
}

export async function verifySchema(db: D1Database, migrations: readonly Migration[] = collectMigrations()): Promise<VerifyResult> {
  await ensureLedger(db);

  const ledger = await db.prepare("SELECT namespace, id, hash FROM dub_migrations").all<{ namespace: string; id: string; hash: string }>();
  const ledgerByKey = new Map((ledger.results ?? []).map((r) => [`${r.namespace}/${r.id}`, r.hash]));

  const drift: string[] = [];
  for (const m of migrations) {
    const key = `${m.namespace}/${m.id}`;
    const recorded = ledgerByKey.get(key);
    if (recorded === undefined || recorded !== hashMigration(m.up)) drift.push(key);
  }

  const present = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
  const presentSet = new Set((present.results ?? []).map((r) => r.name));
  const missingTables = declaredTables(migrations).filter((t) => !presentSet.has(t));

  return { ok: missingTables.length === 0 && drift.length === 0, missingTables, drift };
}
