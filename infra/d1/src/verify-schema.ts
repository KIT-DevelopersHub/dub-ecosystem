// Drift + presence verification. Compares each aggregated migration's current content
// hash against the dub_migrations ledger (drift), every declared table against
// sqlite_master (missingTables), and every declared COLUMN against pragma_table_info
// (missingColumns). Used by `d1:verify` (CI / local file DB), `d1:verify --remote`
// (read-only prod / staging audit) and acceptance test #4.
//
// Why columns: most of this repo's schema evolution is `ALTER TABLE ... ADD COLUMN`,
// which never appears in a CREATE TABLE scan. A table-only check reported ok on a DB
// missing member_people.leader_id for two weeks (every identity-link write 500'd in
// prod). Column-level comparison closes that hole.
import type { D1Database } from "@cloudflare/workers-types";
import { ensureLedger, hashMigration, type Migration } from "@dub/db";
import { collectMigrations } from "./collect";
import { readQualifiedIdent, sliceParenBody, splitTopLevel, sqlStatementList } from "./sql-text";

const CREATE_TABLE = /create\s+table(?:\s+if\s+not\s+exists)?\s+["'`]?([a-zA-Z_][a-zA-Z0-9_]*)/gi;

const CREATE_TABLE_HEAD = /^create\s+(?:temp(?:orary)?\s+)?table\s+(if\s+not\s+exists\s+)?/i;
const ALTER_TABLE_HEAD = /^alter\s+table\s+/i;

/** A column-definition list entry that is a table constraint, not a column. */
const TABLE_CONSTRAINT = /^(?:constraint|primary\s+key|unique|check|foreign\s+key|exclude|period\s+for)\b/i;

/** `ADD <x>` / `DROP <x>` where <x> is a constraint keyword, not a column name. */
const NOT_A_COLUMN = /^(?:constraint|primary|unique|check|foreign|exclude)\b/i;

export interface VerifyResult {
  ok: boolean;
  missingTables: string[];
  /** "<table>.<column>" declared by the migrations but absent from the live DB. */
  missingColumns: string[];
  drift: string[]; // "<ns>/<id>" whose file hash != ledger (or not applied)
  /** false only in read-only mode when dub_migrations does not exist (nothing was ever
   *  applied through this pipeline) — then every migration is reported as drift. */
  ledgerPresent: boolean;
}

export interface VerifySchemaOptions {
  /** Never write to the DB: skip ensureLedger (a CREATE TABLE) and treat a missing
   *  ledger as "not applied". Required when pointing at prod / staging. */
  readOnly?: boolean;
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

/** Column names in a `CREATE TABLE (...)` body, skipping table constraints. */
function parseColumnDefs(body: string): Set<string> {
  const cols = new Set<string>();
  for (const raw of splitTopLevel(body)) {
    const part = raw.trim();
    if (part.length === 0) continue; // trailing comma
    if (TABLE_CONSTRAINT.test(part)) continue;
    const id = readQualifiedIdent(part);
    if (id) cols.add(id.name);
  }
  return cols;
}

interface CreateStmt {
  table: string;
  ifNotExists: boolean;
  columns: Set<string>;
}

function matchCreateTable(stmt: string): CreateStmt | null {
  const head = CREATE_TABLE_HEAD.exec(stmt);
  if (!head) return null;
  const name = readQualifiedIdent(stmt.slice(head[0].length));
  if (!name) return null;
  const rest = name.rest.trimStart();
  if (!rest.startsWith("(")) return null; // e.g. CREATE TABLE x AS SELECT ...
  const body = sliceParenBody(rest);
  if (body === null) return null;
  return { table: name.name, ifNotExists: Boolean(head[1]), columns: parseColumnDefs(body) };
}

type AlterStmt =
  | { kind: "add"; table: string; column: string }
  | { kind: "drop"; table: string; column: string }
  | { kind: "rename"; table: string; column: string; to: string };

function readIdentUnlessKeyword(src: string): string | null {
  if (NOT_A_COLUMN.test(src.trimStart())) return null;
  return readQualifiedIdent(src)?.name ?? null;
}

function matchAlterTable(stmt: string): AlterStmt | null {
  const head = ALTER_TABLE_HEAD.exec(stmt);
  if (!head) return null;
  const name = readQualifiedIdent(stmt.slice(head[0].length));
  if (!name) return null;
  const table = name.name;
  const rest = name.rest.trimStart();

  const add = /^add\s+(?:column\s+)?/i.exec(rest);
  if (add) {
    const col = readIdentUnlessKeyword(rest.slice(add[0].length));
    return col ? { kind: "add", table, column: col } : null;
  }
  const drop = /^drop\s+(?:column\s+)?/i.exec(rest);
  if (drop) {
    const col = readIdentUnlessKeyword(rest.slice(drop[0].length));
    return col ? { kind: "drop", table, column: col } : null;
  }
  // `RENAME COLUMN a TO b` renames a column; `RENAME TO t` renames the TABLE and is
  // ignored (the new name only matters once something CREATEs or ALTERs it).
  const rename = /^rename\s+(?:column\s+)?/i.exec(rest);
  if (rename) {
    const from = readQualifiedIdent(rest.slice(rename[0].length));
    if (!from || from.name.toLowerCase() === "to") return null;
    const to = /^\s*to\s+/i.exec(from.rest);
    if (!to) return null;
    const target = readQualifiedIdent(from.rest.slice(to[0].length));
    return target ? { kind: "rename", table, column: from.name, to: target.name } : null;
  }
  return null;
}

/**
 * Columns each table is expected to have once every migration is applied, derived from
 * the DDL itself: `CREATE TABLE` bodies plus `ALTER TABLE ... ADD/DROP/RENAME COLUMN`.
 * Migrations are walked in `collectMigrations()` order, so later statements win.
 *
 * `CREATE TABLE IF NOT EXISTS` merges into an already-known shape (it is a no-op on an
 * existing table), while a plain `CREATE TABLE` replaces it — that is the standard
 * SQLite "rename aside, recreate, copy rows, drop" rebuild (task/0003), whose new body
 * is the authoritative shape from that point on.
 *
 * The ledger table (dub_migrations) has no migration file (ensureLedger owns it) and is
 * therefore absent here; its presence is still covered by declaredTables().
 */
export function declaredColumns(
  migrations: readonly Migration[] = collectMigrations(),
): Map<string, Set<string>> {
  const byTable = new Map<string, Set<string>>();

  for (const m of migrations) {
    for (const stmt of sqlStatementList(m.up)) {
      const created = matchCreateTable(stmt);
      if (created) {
        const known = byTable.get(created.table);
        if (known && created.ifNotExists) {
          for (const c of created.columns) known.add(c);
        } else {
          byTable.set(created.table, created.columns);
        }
        continue;
      }

      const altered = matchAlterTable(stmt);
      if (!altered) continue;
      const cols = byTable.get(altered.table);
      if (!cols) continue; // ALTER against a table this migration set never declared
      if (altered.kind === "add") cols.add(altered.column);
      else if (altered.kind === "drop") cols.delete(altered.column);
      else {
        cols.delete(altered.column);
        cols.add(altered.to);
      }
    }
  }

  return byTable;
}

async function liveTables(db: D1Database): Promise<Set<string>> {
  const rows = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
  return new Set((rows.results ?? []).map((r) => r.name));
}

/** Live columns per table in ONE round trip — matters for the remote adapter, where
 *  every query costs a wrangler invocation.
 *
 *  Internal tables are excluded because remote D1 answers SQLITE_AUTH (code 7500) for
 *  pragma_table_info('_cf_KV') and would fail the whole query; `sqlite_*` is skipped for
 *  the same class of reason. Neither is ever a declared table. (`substr(...)` rather than
 *  `LIKE '\_%' ESCAPE` — `_` is a LIKE wildcard.) */
const LIVE_COLUMNS_SQL =
  "SELECT m.name AS tbl, p.name AS col FROM sqlite_master m JOIN pragma_table_info(m.name) p" +
  " WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite%' AND substr(m.name, 1, 1) <> '_'";

async function liveColumns(db: D1Database): Promise<Map<string, Set<string>>> {
  const rows = await db.prepare(LIVE_COLUMNS_SQL).all<{ tbl: string; col: string }>();
  const out = new Map<string, Set<string>>();
  for (const r of rows.results ?? []) {
    let set = out.get(r.tbl);
    if (!set) out.set(r.tbl, (set = new Set<string>()));
    set.add(r.col);
  }
  return out;
}

export async function verifySchema(
  db: D1Database,
  migrations: readonly Migration[] = collectMigrations(),
  options: VerifySchemaOptions = {},
): Promise<VerifyResult> {
  const readOnly = options.readOnly === true;
  if (!readOnly) await ensureLedger(db);

  const present = await liveTables(db);
  const ledgerPresent = readOnly ? present.has("dub_migrations") : true;

  const ledgerByKey = new Map<string, string>();
  if (ledgerPresent) {
    const ledger = await db
      .prepare("SELECT namespace, id, hash FROM dub_migrations")
      .all<{ namespace: string; id: string; hash: string }>();
    for (const r of ledger.results ?? []) ledgerByKey.set(`${r.namespace}/${r.id}`, r.hash);
  }

  const drift: string[] = [];
  for (const m of migrations) {
    const key = `${m.namespace}/${m.id}`;
    const recorded = ledgerByKey.get(key);
    if (recorded === undefined || recorded !== hashMigration(m.up)) drift.push(key);
  }

  const missingTables = declaredTables(migrations).filter((t) => !present.has(t));

  const live = await liveColumns(db);
  const missingColumns: string[] = [];
  for (const [table, expected] of declaredColumns(migrations)) {
    if (!present.has(table)) continue; // missingTables owns it — never report twice
    const actual = live.get(table) ?? new Set<string>();
    for (const col of expected) if (!actual.has(col)) missingColumns.push(`${table}.${col}`);
  }
  missingColumns.sort();

  return {
    ok: ledgerPresent && missingTables.length === 0 && missingColumns.length === 0 && drift.length === 0,
    missingTables,
    missingColumns,
    drift,
    ledgerPresent,
  };
}
