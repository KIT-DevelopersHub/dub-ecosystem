// Minimal Gherkin parser + step runner (zero deps). Enough for the Commander
// acceptance specs: Feature / Background / Scenario / Given-When-Then-And-But. No
// Scenario Outline / tables / doc-strings (not needed here). Steps are matched to
// step definitions by regex; the first match wins.

export interface Step {
  keyword: string; // Given | When | Then | And | But
  text: string; // step text with the keyword stripped
}

export interface Scenario {
  name: string;
  steps: Step[];
}

export interface Feature {
  name: string;
  background: Step[];
  scenarios: Scenario[];
}

const STEP_KEYWORDS = ["Given", "When", "Then", "And", "But"] as const;

/** Parse a .feature file's text into a Feature. */
export function parseFeature(source: string): Feature {
  const feature: Feature = { name: "", background: [], scenarios: [] };
  // where new steps go: the background list, or the current scenario's steps.
  let target: Step[] | null = null;
  let inBackground = false;

  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    if (line.startsWith("Feature:")) {
      feature.name = line.slice("Feature:".length).trim();
      target = null;
      inBackground = false;
      continue;
    }
    if (line.startsWith("Background:")) {
      inBackground = true;
      target = feature.background;
      continue;
    }
    if (line.startsWith("Scenario Outline:") || line.startsWith("Scenario:")) {
      const name = line.slice(line.indexOf(":") + 1).trim();
      const scenario: Scenario = { name, steps: [] };
      feature.scenarios.push(scenario);
      inBackground = false;
      target = scenario.steps;
      continue;
    }

    const kw = STEP_KEYWORDS.find((k) => line.startsWith(k + " "));
    if (kw) {
      if (!target) {
        // A step before any Scenario/Background — treat as feature description noise.
        continue;
      }
      target.push({ keyword: kw, text: line.slice(kw.length + 1).trim() });
      continue;
    }
    // Any other line (feature narrative, description) is ignored.
    void inBackground;
  }

  return feature;
}

// ── Step registry ────────────────────────────────────────────────────────────

export type StepFn<W> = (world: W, ...args: string[]) => void | Promise<void>;

interface StepDef<W> {
  re: RegExp;
  fn: StepFn<W>;
}

export class StepRegistry<W> {
  private defs: StepDef<W>[] = [];

  /** Register a step. Capture groups in `re` are passed to `fn` as string args. */
  add(re: RegExp, fn: StepFn<W>): this {
    this.defs.push({ re, fn });
    return this;
  }

  /** Find the matching step def + captured args for a step's text. Throws if none. */
  resolve(text: string): { fn: StepFn<W>; args: string[] } {
    for (const def of this.defs) {
      const m = def.re.exec(text);
      if (m) return { fn: def.fn, args: m.slice(1) };
    }
    throw new Error(`No step definition matches: "${text}"`);
  }
}

/** Run a scenario's steps (background first) against a fresh world. */
export async function runScenario<W>(
  registry: StepRegistry<W>,
  world: W,
  background: Step[],
  steps: Step[],
): Promise<void> {
  for (const step of [...background, ...steps]) {
    const { fn, args } = registry.resolve(step.text);
    await fn(world, ...args);
  }
}
