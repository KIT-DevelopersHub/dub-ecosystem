// @dub/db — namespace-scoped D1 client, forward-only migrations + lint, schema conventions.
export {
  NAMESPACES,
  type Namespace,
  namespaceOf,
  isTableInNamespace,
  isKnownNamespace,
  tablesOf,
} from "./namespaces";
export { newId, ulid, nowIso } from "./ids";
export type { DbErrorCode } from "./errors";
export {
  createDbClient,
  type DbClient,
  type DbClientOptions,
  type DbLogEntry,
  type DbRunResult,
  type DbStatement,
  type Enforcement,
} from "./client";
export {
  applyMigrations,
  ensureLedger,
  hashMigration,
  assertAllApplied,
  type Migration,
  type MigrationResult,
} from "./migrations";
export {
  lintSql,
  lintMigration,
  isLintClean,
  type LintIssue,
  type LintRule,
} from "./lint";
