// FreeqDrainDO alarm-loop behaviour. The DO replaces the retired cron: alarm() must drain
// every bound outbox D1 (reusing the real @dub/freeq drain via drainAll) AND reschedule the
// next alarm so the loop is self-sustaining. A fake DurableObjectState.storage records the
// pending alarm time.
import { describe, it, expect } from "vitest";
import type { D1Database, DurableObjectState } from "@cloudflare/workers-types";
import { FreeqDrainDO, DRAIN_INTERVAL_MS, PRUNE_INTERVAL_MS, LAST_PRUNE_KEY } from "../src/drain-do";
import type { Env } from "../src/env";
import { makeD1, fakeSvc, seed, readRow } from "./d1";

// Minimal DurableObjectState with the alarm storage AND the key/value get/put the DO
// touches (the latter tracks the last-prune timestamp).
function fakeState(): {
  state: DurableObjectState;
  getAlarm: () => number | null;
  kv: Map<string, unknown>;
} {
  let alarm: number | null = null;
  const kv = new Map<string, unknown>();
  const state = {
    storage: {
      async getAlarm() {
        return alarm;
      },
      async setAlarm(t: number) {
        alarm = t;
      },
      async deleteAlarm() {
        alarm = null;
      },
      async get<T>(key: string): Promise<T | undefined> {
        return kv.get(key) as T | undefined;
      },
      async put<T>(key: string, value: T): Promise<void> {
        kv.set(key, value);
      },
    },
  } as unknown as DurableObjectState;
  return { state, getAlarm: () => alarm, kv };
}

// Insert an already-terminal row with an explicit created_at (bypasses the pending-only
// seed()); used to exercise the retention pass.
function seedTerminal(
  raw: ReturnType<typeof makeD1>["raw"],
  id: string,
  status: "done" | "failed",
  createdAt: string,
): void {
  raw
    .prepare(
      `INSERT INTO freeq_outbox (id, topic, payload, status, attempts, next_attempt_at, created_at, last_error)
       VALUES (?, 'audit.record', '{}', ?, 1, ?, ?, NULL)`,
    )
    .run(id, status, createdAt, createdAt);
}

describe("FreeqDrainDO.alarm (drain + self-reschedule)", () => {
  it("drains every bound outbox then reschedules the next alarm ~5min out", async () => {
    const core = makeD1();
    const audit = fakeSvc(200);
    const task = fakeSvc(200);
    seed(core.raw, "c1", "audit.record", { id: "a" });
    seed(core.raw, "c2", "evt.task", { id: "t" });
    const env = { DB_CORE: core.d1, SVC_AUDIT_LOG: audit.svc, SVC_TASK: task.svc } as unknown as Env;
    const fs = fakeState();
    const before = Date.now();

    await new FreeqDrainDO(fs.state, env).alarm();

    // the aggregated drain actually ran
    expect(readRow(core.raw, "c1")).toMatchObject({ status: "done" });
    expect(readRow(core.raw, "c2")).toMatchObject({ status: "done" });
    expect(audit.calls).toHaveLength(1);
    expect(task.calls).toHaveLength(1);
    // and the loop rearmed itself for the next tick
    const next = fs.getAlarm();
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThanOrEqual(before + DRAIN_INTERVAL_MS);
  });

  it("keeps the loop alive even when a bound DB errors (drain is best-effort, never throws)", async () => {
    const core = makeD1();
    const audit = fakeSvc(200);
    seed(core.raw, "c1", "audit.record", { id: "a" });
    const broken = {
      prepare() {
        throw new Error("boom: auth-outbox unavailable");
      },
    } as unknown as D1Database;
    const env = { DB_CORE: core.d1, DB_AUTH: broken, SVC_AUDIT_LOG: audit.svc } as unknown as Env;
    const fs = fakeState();

    await new FreeqDrainDO(fs.state, env).alarm(); // must not throw

    expect(fs.getAlarm()).not.toBeNull(); // next alarm still scheduled -> loop survives
    expect(readRow(core.raw, "c1")).toMatchObject({ status: "done" }); // good DB still drained
  });
});

describe("FreeqDrainDO.alarm (periodic retention prune)", () => {
  const OLD = "2000-01-01T00:00:00.000Z"; // far older than any retention window

  it("does not prune on the first tick (records a baseline) nor again within the interval", async () => {
    const core = makeD1();
    const audit = fakeSvc(200);
    seedTerminal(core.raw, "old-done", "done", OLD);
    const env = { DB_CORE: core.d1, SVC_AUDIT_LOG: audit.svc } as unknown as Env;
    const fs = fakeState();

    await new FreeqDrainDO(fs.state, env).alarm(); // first tick: baseline only
    expect(readRow(core.raw, "old-done")).toMatchObject({ status: "done" }); // NOT pruned
    expect(fs.kv.get(LAST_PRUNE_KEY)).toBeTypeOf("number"); // baseline recorded

    await new FreeqDrainDO(fs.state, env).alarm(); // immediate second tick: within interval
    expect(readRow(core.raw, "old-done")).toMatchObject({ status: "done" }); // still NOT pruned
  });

  it("prunes old terminal (done/failed) rows once the prune interval has elapsed; keeps pending & recent", async () => {
    const core = makeD1();
    const audit = fakeSvc(200);
    seedTerminal(core.raw, "old-done", "done", OLD);
    seedTerminal(core.raw, "old-failed", "failed", "2001-01-01T00:00:00.000Z");
    // A pending row must NEVER be pruned, regardless of age.
    seed(core.raw, "old-pending", "evt.notification", { id: "n" }, OLD);
    // A freshly-created done row is within the retention window -> kept.
    seedTerminal(core.raw, "fresh-done", "done", new Date().toISOString());
    const env = { DB_CORE: core.d1, SVC_AUDIT_LOG: audit.svc } as unknown as Env;
    const fs = fakeState();
    // Pretend the last prune was longer ago than the interval, so this tick prunes.
    fs.kv.set(LAST_PRUNE_KEY, Date.now() - PRUNE_INTERVAL_MS - 1000);

    await new FreeqDrainDO(fs.state, env).alarm();

    expect(readRow(core.raw, "old-done")).toBeUndefined(); // pruned
    expect(readRow(core.raw, "old-failed")).toBeUndefined(); // pruned (30d window still exceeded)
    expect(readRow(core.raw, "old-pending")).toMatchObject({ status: "pending" }); // never pruned
    expect(readRow(core.raw, "fresh-done")).toMatchObject({ status: "done" }); // recent -> kept
    expect(fs.kv.get(LAST_PRUNE_KEY)).toBeGreaterThan(Date.now() - PRUNE_INTERVAL_MS); // advanced
  });

  it("failed rows younger than the (long) failed window survive a prune", async () => {
    const core = makeD1();
    // Failed 10 days ago: past the 3-day done window but inside the 30-day failed window.
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    seedTerminal(core.raw, "recent-failed", "failed", tenDaysAgo);
    const env = { DB_CORE: core.d1 } as unknown as Env;
    const fs = fakeState();
    fs.kv.set(LAST_PRUNE_KEY, Date.now() - PRUNE_INTERVAL_MS - 1000);

    await new FreeqDrainDO(fs.state, env).alarm();

    expect(readRow(core.raw, "recent-failed")).toMatchObject({ status: "failed" }); // retained
  });
});

describe("FreeqDrainDO bootstrap (ensureAlarm / kick fetch)", () => {
  it("ensureAlarm arms exactly one alarm; a second call is a no-op (schedule unchanged)", async () => {
    const fs = fakeState();
    const doo = new FreeqDrainDO(fs.state, {} as Env);

    const first = await doo.ensureAlarm();
    expect(first).toBe(fs.getAlarm());
    expect(fs.getAlarm()).not.toBeNull();

    const second = await doo.ensureAlarm();
    expect(second).toBe(first); // idempotent: does not shift the pending alarm
  });

  it("fetch() (the kick entrypoint) bootstraps the alarm and returns ok", async () => {
    const fs = fakeState();
    const doo = new FreeqDrainDO(fs.state, {} as Env);

    const res = await doo.fetch(new Request("https://freeq-drain-do/internal/ensure-alarm", { method: "POST" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "freeq-drain-do" });
    expect(fs.getAlarm()).not.toBeNull();
  });
});
