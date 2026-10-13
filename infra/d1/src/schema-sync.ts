// Staging schema sync planner. CI never applies D1 migrations, so every new migration on
// main leaves dub-core-staging / dub-core-staging2 behind until someone runs it by hand —
// and the D1 schema gate then fails the next staging deploy (staging2 with lp_publish /
// commander_staging_bundles). scripts/sync-staging-schema.ts asks this planner which ONE
// file to apply next, applies it, re-verifies, and repeats.
//
// A file is only applied when re-running it cannot fail or clobber: every plain
// CREATE TABLE target and every ADD COLUMN target must still be missing, and it must not
// DROP / RENAME. Anything else is reported for a human instead.
import type { Migration } from "@dub/db";
import { schemaOps } from "./verify-schema";

export type SchemaFix =
  | { kind: "apply"; migration: Migration }
  | { kind: "blocked"; reason: string };

const key = (m: Migration) => `${m.namespace}/${m.id}`;

/** Next migration that fills a missing table/column, or null when nothing is missing. */
export function nextSchemaFix(
  migrations: readonly Migration[],
  missingTables: readonly string[],
  missingColumns: readonly string[],
): SchemaFix | null {
  const tables = new Set(missingTables);
  const columns = new Set(missingColumns);
  if (tables.size === 0 && columns.size === 0) return null;

  for (const m of migrations) {
    const ops = schemaOps(m);
    const fills =
      ops.creates.some((c) => tables.has(c.table)) ||
      ops.adds.some((a) => columns.has(`${a.table}.${a.column}`));
    if (!fills) continue;

    if (ops.destructive > 0) {
      return { kind: "blocked", reason: `${key(m)} drops/renames columns; apply it by hand` };
    }
    const createdHere = new Set<string>();
    for (const c of ops.creates) {
      if (!c.ifNotExists && !tables.has(c.table)) {
        return { kind: "blocked", reason: `${key(m)} re-creates existing table ${c.table}` };
      }
      createdHere.add(c.table);
    }
    for (const a of ops.adds) {
      const col = `${a.table}.${a.column}`;
      if (!columns.has(col) && !createdHere.has(a.table)) {
        return { kind: "blocked", reason: `${key(m)} adds ${col}, which already exists` };
      }
    }
    return { kind: "apply", migration: m };
  }

  const rest = [...tables, ...columns].join(", ");
  return { kind: "blocked", reason: `no migration file adds: ${rest}` };
}
