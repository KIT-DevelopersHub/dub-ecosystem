import { describe, it, expect } from "vitest";
import type { DurableObjectState } from "@cloudflare/workers-types";
import { MeterDO, DAILY_INTERVAL_MS, FIRST_RUN_DELAY_MS, collectionProblem } from "../src/meter-do";
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
    // alarm() collects against the real clock (startOfUtcDay(now)), so seed sends on the
    // CURRENT UTC day — a fixed calendar date made this assertion flake once the day rolled.
    const today = new Date().toISOString().slice(0, 10);
    seedSend(raw, "s1", `${today}T01:00:00.000Z`);
    seedSend(raw, "s2", `${today}T02:00:00.000Z`);
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
    const before = Date.now();
    const first = await doo.ensureAlarm();
    expect(first).toBe(fs.getAlarm());
    // first run is soon (a re-armed loop must refresh stale data now, not tomorrow)
    expect(first).toBeLessThanOrEqual(before + FIRST_RUN_DELAY_MS + 1000);
    const second = await doo.ensureAlarm();
    expect(second).toBe(first);
  });

  it("replaces an overdue alarm (a past-due alarm that never fired left prod dead for weeks)", async () => {
    const fs = fakeState();
    const weeksAgo = Date.now() - 21 * DAILY_INTERVAL_MS;
    await fs.state.storage.setAlarm(weeksAgo);
    const before = Date.now();
    const at = await new MeterDO(fs.state, {} as Env).ensureAlarm();
    expect(at).toBeGreaterThan(before);
    expect(at).toBeLessThanOrEqual(before + FIRST_RUN_DELAY_MS + 1000);
    expect(fs.getAlarm()).toBe(at);
  });

  it("replaces an alarm scheduled beyond the daily interval", async () => {
    const fs = fakeState();
    await fs.state.storage.setAlarm(Date.now() + 10 * DAILY_INTERVAL_MS);
    const before = Date.now();
    const at = await new MeterDO(fs.state, {} as Env).ensureAlarm();
    expect(at).toBeLessThanOrEqual(before + FIRST_RUN_DELAY_MS + 1000);
  });

  it("keeps a healthy pending alarm (next daily run)", async () => {
    const fs = fakeState();
    const next = Date.now() + DAILY_INTERVAL_MS - 60_000;
    await fs.state.storage.setAlarm(next);
    expect(await new MeterDO(fs.state, {} as Env).ensureAlarm()).toBe(next);
  });

  it("fetch() bootstraps the alarm and returns ok", async () => {
    const fs = fakeState();
    const res = await new MeterDO(fs.state, {} as Env).fetch(new Request("https://usage-meter-do/x", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "usage-meter-do" });
    expect(fs.getAlarm()).not.toBeNull();
  });
});

describe("MeterDO.alarm never throws (a throwing alarm is retried 6x, then dropped for good)", () => {
  it("still collects and does not throw when rescheduling itself fails", async () => {
    const { d1, raw } = makeD1();
    const fs = fakeState();
    (fs.state.storage as unknown as { setAlarm: () => Promise<void> }).setAlarm = async () => {
      throw new Error("storage unavailable");
    };
    await expect(new MeterDO(fs.state, { DB: d1 } as unknown as Env).alarm()).resolves.toBeUndefined();
    expect(countSnapshot(raw)).toBe(MASTER.length);
  });

  it("does not throw when the collection itself throws", async () => {
    const fs = fakeState();
    const broken = {
      prepare() {
        throw new Error("D1_ERROR: daily write limit exceeded");
      },
    };
    await expect(new MeterDO(fs.state, { DB: broken } as unknown as Env).alarm()).resolves.toBeUndefined();
    expect(fs.getAlarm()).not.toBeNull();
    expect(fs.store.get("collect:consecutiveFailures")).toBe(1);
  });
});

describe("MeterDO collection health (consecutive failures -> admin alert)", () => {
  function mailRecorder(): { svc: unknown; sent: unknown[] } {
    const sent: unknown[] = [];
    const svc = {
      async fetch(req: Request) {
        sent.push(JSON.parse(await req.text()));
        return new Response(JSON.stringify({ messageId: "m", provider: "resend", acceptedAt: "t" }), {
          headers: { "content-type": "application/json" },
        });
      },
    };
    return { svc, sent };
  }

  it("counts a run with every Cloudflare metric unknown as a failure and alerts on the 2nd in a row", async () => {
    const { d1 } = makeD1();
    const mail = mailRecorder();
    // no CF token -> every Cloudflare metric unknown (what a revoked token looks like)
    const env = { DB: d1, SVC_MAIL_GATEWAY: mail.svc } as unknown as Env;
    const fs = fakeState();

    await new MeterDO(fs.state, env).alarm();
    expect(fs.store.get("collect:consecutiveFailures")).toBe(1);
    expect(mail.sent).toHaveLength(0);

    await new MeterDO(fs.state, env).alarm();
    expect(fs.store.get("collect:consecutiveFailures")).toBe(2);
    expect(mail.sent).toHaveLength(1);
    expect((mail.sent[0] as { textBody: string }).textBody).toContain("Cloudflare");
  });

  it("a healthy run resets the counter and records the last success", async () => {
    const fs = fakeState();
    fs.store.set("collect:consecutiveFailures", 3);
    const { d1 } = makeD1();
    const doo = new MeterDO(fs.state, { DB: d1 } as unknown as Env);
    // stub a healthy collection
    doo.runCollection = async () => ({ metrics: 12, worstStatus: "ok", newlyAlerted: 0, problem: null });
    await doo.alarm();
    expect(fs.store.get("collect:consecutiveFailures")).toBe(0);
    expect(typeof fs.store.get("collect:lastSuccessAt")).toBe("string");
  });
});

describe("collectionProblem", () => {
  const r = (provider: "cloudflare" | "resend", status: "ok" | "unknown") =>
    ({ provider, metric_key: `${provider}_${status}`, label: "x", used: null, limit_value: 1, pct: null, unit: "u", overflow_behavior: "halt", status }) as const;

  it("flags a run where no Cloudflare metric could be read", () => {
    expect(collectionProblem([r("cloudflare", "unknown"), r("cloudflare", "unknown"), r("resend", "ok")])).toMatch(/Cloudflare/);
  });

  it("accepts a run with at least one Cloudflare reading", () => {
    expect(collectionProblem([r("cloudflare", "ok"), r("cloudflare", "unknown")])).toBeNull();
  });
});
