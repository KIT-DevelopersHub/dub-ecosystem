import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { RunStore } from "../src/runner.ts";
import type { DaemonConfig, RunEvent } from "../src/types.ts";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude", import.meta.url));

function config(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    port: 0,
    claudeBin: FAKE_CLAUDE,
    defaultCwd: tmpdir(),
    extraArgs: [],
    ...overrides,
  };
}

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

describe("RunStore exec bridge", () => {
  it("spawns the CLI and relays parsed stream-json events to succeeded", async () => {
    const store = new RunStore(config());
    const run = store.start({ prompt: "say pong" });
    expect(run.status).toBe("running"); // set synchronously after spawn

    const events = await collectUntilDone(store, run.id);

    const claudeEvents = events.filter((e) => e.type === "claude");
    expect(claudeEvents.length).toBe(2);
    expect((claudeEvents[1] as { data: { result: string } }).data.result).toBe("PONG");

    const exit = events.find((e) => e.type === "exit");
    expect(exit && exit.type === "exit" && exit.code).toBe(0);

    expect(store.get(run.id)!.status).toBe("succeeded");
  });

  it("marks the run failed when the CLI binary is missing", async () => {
    const store = new RunStore(config({ claudeBin: "/no/such/claude-binary-xyz" }));
    const run = store.start({ prompt: "hi" });
    const events = await collectUntilDone(store, run.id);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(store.get(run.id)!.status).toBe("failed");
  });

  it("lists runs newest-first", async () => {
    const store = new RunStore(config());
    const a = store.start({ prompt: "a" });
    await collectUntilDone(store, a.id);
    const b = store.start({ prompt: "b" });
    await collectUntilDone(store, b.id);
    const list = store.list();
    expect(list[0]!.id).toBe(b.id);
  });
});
