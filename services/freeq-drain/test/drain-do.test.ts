// FreeqDrainDO alarm-loop behaviour. The DO replaces the retired cron: alarm() must drain
// every bound outbox D1 (reusing the real @dub/freeq drain via drainAll) AND reschedule the
// next alarm so the loop is self-sustaining. A fake DurableObjectState.storage records the
// pending alarm time.
import { describe, it, expect } from "vitest";
import type { D1Database, DurableObjectState } from "@cloudflare/workers-types";
import { FreeqDrainDO, DRAIN_INTERVAL_MS } from "../src/drain-do";
import type { Env } from "../src/env";
import { makeD1, fakeSvc, seed, readRow } from "./d1";

// Minimal DurableObjectState with just the alarm storage the DO touches.
function fakeState(): { state: DurableObjectState; getAlarm: () => number | null } {
  let alarm: number | null = null;
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
    },
  } as unknown as DurableObjectState;
  return { state, getAlarm: () => alarm };
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
