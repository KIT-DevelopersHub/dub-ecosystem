import { describe, it, expect } from "vitest";
import type { DurableObjectState } from "@cloudflare/workers-types";
import { MeterDO, DAILY_INTERVAL_MS } from "../src/meter-do";
import type { Env } from "../src/env";
import { MASTER } from "../src/limits";
import { makeD1, seedSend, readSnapshot, countSnapshot } from "./d1";

function fakeState(): { state: DurableObjectState; getAlarm: () => number | null; store: Map<string, unknown> } {
  let alarm: number | null = null;
  const store = new Map<string, unknown>();
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
      async get(k: string) {
        return store.get(k);
      },
      async put(k: string, v: unknown) {
        store.set(k, v);
      },
    },
  } as unknown as DurableObjectState;
  return { state, getAlarm: () => alarm, store };
}

describe("MeterDO.alarm (collect + upsert + self-reschedule)", () => {
  it("collects usage into usage_snapshot and rearms the next daily alarm", async () => {
    const { d1, raw } = makeD1();
    seedSend(raw, "s1", "2026-08-12T01:00:00.000Z");
    seedSend(raw, "s2", "2026-08-12T02:00:00.000Z");
    const env = { DB: d1 } as unknown as Env; // no CF token -> CF metrics unknown, Resend measured
    const fs = fakeState();
    const before = Date.now();

    await new MeterDO(fs.state, env).alarm();

    // every master metric persisted (one row each)
    expect(countSnapshot(raw)).toBe(MASTER.length);
    // Resend day count measured from the send log
    const resend = readSnapshot(raw, "resend_emails_day")!;
    expect(resend.used).toBe(2);
    expect(resend.status).toBe("ok");
    // Cloudflare metric with no token -> unknown
    const workers = readSnapshot(raw, "workers_requests_day")!;
    expect(workers.used).toBeNull();
    expect(workers.status).toBe("unknown");
    // loop rearmed ~24h out
    const next = fs.getAlarm();
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThanOrEqual(before + DAILY_INTERVAL_MS);
  });

  it("re-collection UPSERTs the same day (no duplicate rows)", async () => {
    const { d1, raw } = makeD1();
    seedSend(raw, "s1", "2026-08-12T01:00:00.000Z");
    const env = { DB: d1 } as unknown as Env;
    const fs = fakeState();

    await new MeterDO(fs.state, env).runCollection(new Date("2026-08-12T09:00:00.000Z"));
    seedSend(raw, "s2", "2026-08-12T10:00:00.000Z");
    await new MeterDO(fs.state, env).runCollection(new Date("2026-08-12T11:00:00.000Z"));

    expect(countSnapshot(raw)).toBe(MASTER.length); // still one row per metric
    expect(readSnapshot(raw, "resend_emails_day")!.used).toBe(2); // updated value
  });

  it("never throws from alarm() even when DB is unbound (loop preserved)", async () => {
    const env = {} as unknown as Env;
    const fs = fakeState();
    await new MeterDO(fs.state, env).alarm();
    expect(fs.getAlarm()).not.toBeNull();
  });
});

describe("MeterDO bootstrap (ensureAlarm / kick fetch)", () => {
  it("ensureAlarm arms exactly one alarm; a second call is a no-op", async () => {
    const fs = fakeState();
    const doo = new MeterDO(fs.state, {} as Env);
    const first = await doo.ensureAlarm();
    expect(first).toBe(fs.getAlarm());
    const second = await doo.ensureAlarm();
    expect(second).toBe(first);
  });

  it("fetch() bootstraps the alarm and returns ok", async () => {
    const fs = fakeState();
    const res = await new MeterDO(fs.state, {} as Env).fetch(new Request("https://usage-meter-do/x", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "usage-meter-do" });
    expect(fs.getAlarm()).not.toBeNull();
  });
});
