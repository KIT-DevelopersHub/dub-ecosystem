// @dub/infra-d1 — the single source of truth for the shared dub-core D1: schema
// aggregation, forward-only migration + lint pipeline, drift verification, and the
// idempotent demo seed (scenarios + fixtures). No HTTP surface; consumed by CI, the
// d1:* scripts, #29 E2E, and every service test.
export { NAMESPACE_REGISTRY, registryEntry, type NamespaceEntry } from "./registry";
export { collectMigrations, MIGRATIONS_DIR } from "./collect";
export { lintAll, lintAllErrors, sanitizeForLint, type LintReport } from "./lint-all";
export { applyAll, type ApplyResult } from "./apply";
export {
  verifySchema,
  declaredTables,
  declaredColumns,
  type VerifyResult,
  type VerifySchemaOptions,
} from "./verify-schema";
export { type SeedErrorCode, PROD_DB_NAME } from "./errors";
// NOTE: ./node-d1 and ./remote-d1 are intentionally NOT re-exported — they pull in
// node:sqlite / node:child_process and must never reach a Worker bundle. Import them by
// path from scripts and tests.

export {
  seedScenario,
  type SeedScenarioName,
  type SeedScenarioOptions,
  type SeedHandle,
} from "../seed/scenarios";
export { SEED, fixtureHash, type TestUserKey } from "../seed/fixtures";
