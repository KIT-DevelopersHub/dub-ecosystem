// Seed orchestration helpers used by the d1:seed / d1:reset scripts and by tests that
// want a fully-provisioned DB in one call. Thin wrappers over applyAll + seedScenario;
// the prod guard lives in seedScenario (database_name check).
import type { D1Database } from "@cloudflare/workers-types";
import { applyAll } from "../src/apply";
import { seedScenario, type SeedScenarioName, type SeedScenarioOptions, type SeedHandle } from "./scenarios";

/** Apply all migrations, then seed the given scenario. Idempotent. */
export async function applyAndSeed(
  db: D1Database,
  scenario: SeedScenarioName = "conference-demo",
  opts: SeedScenarioOptions = {},
): Promise<SeedHandle> {
  await applyAll(db);
  return seedScenario(db, scenario, opts);
}
