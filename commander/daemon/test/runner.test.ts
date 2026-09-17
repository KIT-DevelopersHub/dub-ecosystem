import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { RunStore } from "../src/runner.ts";
import type { RunSink } from "../src/sink.ts";
import type { DaemonConfig, Run, RunEvent } from "../src/types.ts";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude", import.meta.url));
const SLOW_CLAUDE = fileURLToPath(new URL("./fixtures/slow-claude", import.meta.url));

function config(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    port: 0,
    claudeBin: FAKE_CLAUDE,
    defaultCwd: tmpdir(),
    extraArgs: [],
    operatorToken: "",
    idleTimeoutMs: 0,
    runTimeoutMs: 0,
    isolateEnv: true,
    claudeConfigDir: "",
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

  it("cancel() kills a running run and marks it failed with a cancellation note", async () => {
    const store = new RunStore(config({ claudeBin: SLOW_CLAUDE }));
    const run = store.start({ prompt: "long task" });
    expect(store.isActive(run.id)).toBe(true);

    const done = collectUntilDone(store, run.id);
    expect(store.cancel(run.id)).toBe(true);
    const events = await done;

    expect(store.get(run.id)!.status).toBe("failed");
    expect(
      events.some((e) => e.type === "error" && e.message.includes("cancelled")),
    ).toBe(true);
    expect(store.isActive(run.id)).toBe(false);
    expect(store.cancel(run.id)).toBe(false); // no longer active
  });

  it("kills a run that exceeds runTimeoutMs and marks it failed (timeout)", async () => {
    const store = new RunStore(config({ claudeBin: SLOW_CLAUDE, runTimeoutMs: 60 }));
    const run = store.start({ prompt: "long task" });
    const events = await collectUntilDone(store, run.id);

    expect(store.get(run.id)!.status).toBe("failed");
    expect(
      events.some((e) => e.type === "error" && e.message.includes("timed out")),
    ).toBe(true);
  });

  it("mirrors the run and its events to the sink (persistence wiring)", async () => {
    const started: Run[] = [];
    const persisted: Array<{ runId: string; event: RunEvent }> = [];
    const sink: RunSink = {
      runStarted: (r) => started.push(r),
      runEvent: (runId, event) => persisted.push({ runId, event }),
    };
    const store = new RunStore(config(), sink);
    const run = store.start({ prompt: "say pong" });
    await collectUntilDone(store, run.id);

    expect(started.map((r) => r.id)).toEqual([run.id]);
    // status transitions (running → succeeded) + exit + claude lines all mirrored.
    expect(persisted.every((p) => p.runId === run.id)).toBe(true);
    expect(persisted.some((p) => p.event.type === "status" && p.event.status === "succeeded")).toBe(true);
    expect(persisted.some((p) => p.event.type === "exit")).toBe(true);
  });
});
