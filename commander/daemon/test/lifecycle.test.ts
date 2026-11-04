import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { RunStore } from "../src/runner.ts";
import type { RunSink } from "../src/sink.ts";
import type { DaemonConfig, RunEvent } from "../src/types.ts";
import { ORPHAN_NOTICE, abortInFlightRuns, reconcileAtBoot } from "../src/lifecycle.ts";

const SLOW_CLAUDE = fileURLToPath(new URL("./fixtures/slow-claude", import.meta.url));

function config(): DaemonConfig {
  return {
    port: 0,
    claudeBin: SLOW_CLAUDE,
    defaultCwd: tmpdir(),
    extraArgs: [],
    operatorToken: "",
    idleTimeoutMs: 0,
    runTimeoutMs: 0,
    isolateEnv: true,
    claudeConfigDir: "",
    permissionMode: "acceptEdits",
  };
}

describe("boot reconcile (orphaned runs)", () => {
  it("POSTs /runs/reconcile with the boot instant, owned ids, token and notice", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ reconciled: ["r1", "r2"] }), { status: 200 });
    }) as unknown as typeof fetch;
    const ids = await reconcileAtBoot({
      serviceUrl: "http://svc/",
      serviceToken: "tok",
      before: "2026-11-04T00:00:00.000Z",
      ownedIds: () => ["mine"],
      fetchImpl,
      log: () => {},
    });
    expect(ids).toEqual(["r1", "r2"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://svc/runs/reconcile");
    expect((calls[0]!.init.headers as Record<string, string>)["x-commander-token"]).toBe("tok");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      before: "2026-11-04T00:00:00.000Z",
      exceptIds: ["mine"],
      line: ORPHAN_NOTICE,
    });
  });

  it("retries while the service is down and never rejects", async () => {
    let n = 0;
    const flaky = (async () => {
      n++;
      if (n < 3) throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify({ reconciled: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(
      reconcileAtBoot({ serviceUrl: "http://svc", before: "x", fetchImpl: flaky, delayMs: 1, log: () => {} }),
    ).resolves.toEqual([]);
    expect(n).toBe(3);

    const down = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    await expect(
      reconcileAtBoot({ serviceUrl: "http://svc", before: "x", fetchImpl: down, attempts: 2, delayMs: 1, log: () => {} }),
    ).resolves.toBeNull();
  });
});

describe("graceful shutdown", () => {
  it("fails in-flight runs with the notice (exit null) and flushes the sink", async () => {
    const persisted: Array<{ runId: string; event: RunEvent }> = [];
    let flushed = 0;
    const sink: RunSink = {
      runStarted: () => {},
      runEvent: (runId, event) => persisted.push({ runId, event }),
      flush: async () => {
        flushed++;
      },
    };
    const store = new RunStore(config(), sink);
    const run = store.start({ prompt: "long job" });
    expect(store.activeCount()).toBe(1);

    const ids = await abortInFlightRuns(store, sink, 100);
    expect(ids).toEqual([run.id]);
    expect(flushed).toBe(1);
    expect(store.activeCount()).toBe(0);
    expect(store.get(run.id)!.status).toBe("failed");
    expect(store.get(run.id)!.exitCode).toBeNull();

    const types = persisted.filter((p) => p.runId === run.id).map((p) => p.event);
    const tail = types.slice(-3);
    expect(tail[0]).toMatchObject({ type: "stderr", line: ORPHAN_NOTICE });
    expect(tail[1]).toMatchObject({ type: "exit", code: null });
    expect(tail[2]).toMatchObject({ type: "status", status: "failed" });

    // The killed child's close handler must not append a second terminal trail.
    const before = persisted.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(persisted.length).toBe(before);
  });

  it("is a no-op with nothing in flight", async () => {
    const store = new RunStore(config());
    expect(await abortInFlightRuns(store, { runStarted() {}, runEvent() {} })).toEqual([]);
  });
});
