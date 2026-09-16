// Executable BDD: loads every commander/features/*.feature, and runs each Scenario's
// Given/When/Then steps against the REAL daemon + commander-service + app-registry via
// the step definitions in steps.ts. One vitest `it` per Scenario; a fresh World per
// scenario, torn down afterwards.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, afterEach } from "vitest";
import { parseFeature, runScenario } from "./support/gherkin.ts";
import { World } from "./support/world.ts";
import { defineSteps } from "./steps.ts";

const FEATURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../features");
const registry = defineSteps();

const files = readdirSync(FEATURES_DIR)
  .filter((f) => f.endsWith(".feature"))
  .sort();

for (const file of files) {
  const feature = parseFeature(readFileSync(join(FEATURES_DIR, file), "utf8"));

  describe(`Feature: ${feature.name} (${file})`, () => {
    let world: World;
    afterEach(async () => {
      if (world) await world.teardown();
    });

    for (const scenario of feature.scenarios) {
      it(scenario.name, async () => {
        world = new World();
        await runScenario(registry, world, feature.background, scenario.steps);
      });
    }
  });
}
