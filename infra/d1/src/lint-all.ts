// Lint the aggregated schema against @dub/db's SQL rules (namespace boundaries, table/
// column naming, cross-namespace FK, forbidden statements). Two sanitizations keep the
// heuristic linter honest on real DDL:
//   1. line comments are stripped (their prose contains SQL keywords like "delete from")
//   2. CREATE TRIGGER bodies are stripped — they legitimately contain UPDATE/DELETE/
//      SELECT keywords that the table-oriented linter would misread as table refs
//      (e.g. "BEFORE UPDATE ON audit_logs" captures "ON" as a bogus table). Triggers
//      are DML guards, not table DDL; excluding them is the "approved exemption" the
//      acceptance criteria allow (#3: error 0 excluding approved exemptions).
import { lintMigration, type LintIssue, type Migration } from "@dub/db";
import { collectMigrations } from "./collect";

function stripLineComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function stripTriggers(sql: string): string {
  return sql.replace(/create\s+trigger[\s\S]*?end\s*;/gi, "");
}

/** SQL that lint should see: prose comments and trigger bodies removed. */
export function sanitizeForLint(sql: string): string {
  return stripTriggers(stripLineComments(sql));
}

export interface LintReport {
  migrationId: string;
  namespace: string;
  issues: LintIssue[];
}

/** Lint every aggregated migration. Draft namespaces (chat) are linted too but are
 *  excluded from the frozen gate by lintAllErrors (they are 凍結対象外). */
export function lintAll(migrations: readonly Migration[] = collectMigrations()): LintReport[] {
  return migrations.map((m) => ({
    migrationId: m.id,
    namespace: m.namespace,
    issues: lintMigration({ ...m, up: sanitizeForLint(m.up) }),
  }));
}

/**
 * Documented, narrowly-scoped exemptions from the `forbidden-statement` rule
 * (DROP / ATTACH / PRAGMA). The frozen namespaces normally forbid these because a
 * plain forward migration never needs them — but relaxing a column constraint in
 * SQLite (no `ALTER COLUMN`) requires the standard data-preserving table-rebuild,
 * which legitimately uses PRAGMA (foreign_keys / legacy_alter_table) + DROP of the
 * renamed-aside table. Each entry is keyed by exact "<namespace>/<id>" and only the
 * `forbidden-statement` rule is waived — all other lint rules still gate the file.
 * Approved: 判断61 (task→event optional; see PR #214).
 */
const FORBIDDEN_STATEMENT_EXEMPTIONS: ReadonlySet<string> = new Set([
  "task/0003_event_id_nullable", // NOT NULL removal via FK-safe table rebuild
]);

/** Error-level issues that gate CI — draft namespaces excluded (theme-12). */
export function lintAllErrors(
  migrations: readonly Migration[] = collectMigrations(),
  draftNamespaces: readonly string[] = ["chat"],
): LintReport[] {
  return lintAll(migrations)
    .filter((r) => !draftNamespaces.includes(r.namespace))
    .map((r) => {
      const key = `${r.namespace}/${r.migrationId}`;
      const exempt = FORBIDDEN_STATEMENT_EXEMPTIONS.has(key);
      return {
        ...r,
        issues: r.issues.filter(
          (i) => i.level === "error" && !(exempt && i.rule === "forbidden-statement"),
        ),
      };
    })
    .filter((r) => r.issues.length > 0);
}
