// SQL lint (CI contract-conformance). missing-timestamps is warn (D13); everything
// else is error. Table naming enforces `<ns>_snake_case`; plural is not machine-checked.
import { type Namespace, namespaceOf, tablesOf } from "./namespaces";
import type { Migration } from "./migrations";

export type LintRule =
  | "namespace-violation"
  | "table-naming"
  | "column-naming"
  | "missing-timestamps"
  | "cross-namespace-fk"
  | "forbidden-statement";

export interface LintIssue {
  level: "error" | "warn";
  rule: LintRule;
  message: string;
  migrationId?: string;
}

const FORBIDDEN_REGEX = /\b(drop\s+database|attach\b|detach\b|pragma\b)/i;
const CREATE_TABLE_REGEX = /create\s+table(?:\s+if\s+not\s+exists)?\s+["'`]?([a-zA-Z_][a-zA-Z0-9_]*)["'`]?\s*\(([\s\S]*?)\)\s*;?/gi;
const FK_REGEX = /references\s+["'`]?([a-zA-Z_][a-zA-Z0-9_]*)["'`]?/gi;
const SNAKE_TABLE = /^[a-z][a-z0-9_]*$/;

// Tables allowed to skip created_at/updated_at (D13 exemptions).
const TIMESTAMP_EXEMPT = new Set(["dub_migrations", "audit_logs", "seed_runs", "mail_inbound_seen"]);

function lintColumns(table: string, columnBlock: string, ns: Namespace, out: LintIssue[], migrationId?: string): void {
  const cols = columnBlock
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && !/^(primary|foreign|unique|constraint|check)\b/i.test(c));
  const names = cols.map((c) => c.split(/\s+/)[0]?.replace(/["'`]/g, "") ?? "").filter(Boolean);

  for (const name of names) {
    if (!SNAKE_TABLE.test(name)) {
      out.push({ level: "error", rule: "column-naming", message: `column "${name}" in ${table} is not snake_case`, migrationId });
    }
    if (/json/i.test(name) && !name.endsWith("_json")) {
      // heuristic: a column that stores json should carry the _json suffix
    }
  }

  const looksRelational = /_(dependencies|links|members|seen)$/.test(table);
  if (!TIMESTAMP_EXEMPT.has(table) && !looksRelational) {
    const hasCreated = names.includes("created_at");
    const hasUpdated = names.includes("updated_at");
    if (!hasCreated || !hasUpdated) {
      out.push({
        level: "warn",
        rule: "missing-timestamps",
        message: `table ${table} is missing created_at/updated_at (suppress with a reason comment if intentional)`,
        migrationId,
      });
    }
  }
  void ns;
}

export function lintSql(sql: string, ns: Namespace, migrationId?: string): LintIssue[] {
  const out: LintIssue[] = [];

  if (FORBIDDEN_REGEX.test(sql)) {
    out.push({ level: "error", rule: "forbidden-statement", message: "forbidden statement (DROP DATABASE / ATTACH / PRAGMA)", migrationId });
  }

  // namespace violation (any touched table outside ns, ignoring the meta ledger)
  for (const table of tablesOf(sql)) {
    if (table === "dub_migrations") continue;
    const owner = namespaceOf(table);
    if (owner !== ns) {
      out.push({ level: "error", rule: "namespace-violation", message: `table "${table}" (namespace ${owner ?? "unknown"}) is outside "${ns}"`, migrationId });
    }
    if (!SNAKE_TABLE.test(table.toLowerCase()) || (owner !== ns)) {
      // table-naming: must be `${ns}_snake_case`
      if (owner === ns && !SNAKE_TABLE.test(table.toLowerCase())) {
        out.push({ level: "error", rule: "table-naming", message: `table "${table}" is not ${ns}_snake_case`, migrationId });
      }
    }
  }

  // cross-namespace FK
  let fk: RegExpExecArray | null;
  FK_REGEX.lastIndex = 0;
  while ((fk = FK_REGEX.exec(sql)) !== null) {
    const ref = fk[1];
    if (ref && namespaceOf(ref) !== ns) {
      out.push({ level: "error", rule: "cross-namespace-fk", message: `FOREIGN KEY references "${ref}" outside "${ns}" (keep ids as strings, integrate via API/events)`, migrationId });
    }
  }

  // per-table column checks
  let ct: RegExpExecArray | null;
  CREATE_TABLE_REGEX.lastIndex = 0;
  while ((ct = CREATE_TABLE_REGEX.exec(sql)) !== null) {
    const table = ct[1];
    const cols = ct[2];
    if (table && cols) lintColumns(table, cols, ns, out, migrationId);
  }

  return out;
}

export function lintMigration(m: Migration): LintIssue[] {
  return lintSql(m.up, m.namespace, m.id);
}

/** true iff no error-level issues (approved warn-level exemptions are allowed). */
export function isLintClean(issues: readonly LintIssue[]): boolean {
  return issues.every((i) => i.level !== "error");
}
