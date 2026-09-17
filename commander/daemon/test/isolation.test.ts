// End-to-end proof that a run spawned by the daemon does NOT inherit the operator's
// personal env: we set PERSONAL_SECRET + a personal CLAUDE_CONFIG_DIR on THIS process,
// spawn a fake claude that echoes what it actually received, and assert the personal
// values were stripped and CLAUDE_CONFIG_DIR was redirected to Commander's home.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { RunStore } from "../src/runner.ts";
import type { DaemonConfig, RunEvent } from "../src/types.ts";

const ENV_ECHO = fileURLToPath(new URL("./fixtures/env-echo-claude", import.meta.url));
const COMMANDER_HOME = "/tmp/commander-test-home";

function collectUntilDone(store: RunStore, id: string): Promise<RunEvent[]> {
  return new Promise((resolve) => {
    const events: RunEvent[] = [];
    const unsub = store.subscribe(id, (ev) => {
      events.push(ev);
      if (ev.type === "status" && (ev.status === "succeeded" || ev.status === "failed")) {
        unsub();
        resolve(events);
      }
    });
  });
}

function readObserved(events: RunEvent[]): Record<string, unknown> {
  const claude = events.find((e) => e.type === "claude") as
    | { type: "claude"; data: { result: string } }
    | undefined;
  return JSON.parse(claude!.data.result) as Record<string, unknown>;
}

function config(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    port: 0,
    claudeBin: ENV_ECHO,
    defaultCwd: tmpdir(),
    extraArgs: [],
    isolateEnv: true,
    claudeConfigDir: COMMANDER_HOME,
    ...overrides,
  };
}

describe("spawn env isolation (runtime)", () => {
  beforeAll(() => {
    process.env.PERSONAL_SECRET = "operator-only";
    process.env.CLAUDE_CONFIG_DIR = "/Users/operator/.claude";
    process.env.COMMANDER_PASSTHROUGH = "kept";
  });
  afterAll(() => {
    delete process.env.PERSONAL_SECRET;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.COMMANDER_PASSTHROUGH;
  });

  it("spawned claude sees Commander's CLAUDE_CONFIG_DIR, not the personal ~/.claude", async () => {
    const store = new RunStore(config());
    const run = store.start({ prompt: "echo env" });
    const observed = readObserved(await collectUntilDone(store, run.id));

    expect(observed.CLAUDE_CONFIG_DIR).toBe(COMMANDER_HOME);
    expect(observed.PERSONAL_SECRET).toBeNull(); // stripped
    expect(observed.COMMANDER_PASSTHROUGH).toBe("kept"); // preserved
    expect(observed.HAS_PATH).toBe(true); // still runnable
  });

  it("without isolation the personal env leaks (documents the OLD broken behavior)", async () => {
    const store = new RunStore(config({ isolateEnv: false }));
    const run = store.start({ prompt: "echo env" });
    const observed = readObserved(await collectUntilDone(store, run.id));

    // Full inherit; CLAUDE_CONFIG_DIR still redirected so config is never personal.
    expect(observed.PERSONAL_SECRET).toBe("operator-only");
    expect(observed.CLAUDE_CONFIG_DIR).toBe(COMMANDER_HOME);
  });
});
