// Regression for the 2026-09-21 production stall: the DO alarm chain died at 14:45Z and,
// with no backstop able to re-arm it, ZERO freeq_outbox rows were delivered for two months
// (~11k pending). Guards:
//   1. alarm() never throws and always leaves a pending alarm (a throwing alarm is retried
//      then DROPPED by the runtime — that ends a self-rescheduling loop for good).
//   2. ensureAlarm (the kick, called by the mail-gateway cron backstop) re-arms a missing
//      OR wedged/overdue alarm, and is a no-op on a healthy one.
//   3. one tick stays under the Free plan's 50-subrequest cap (the stall era hit "Too many
//      subrequests by single Worker invocation" every tick: 25 rows x 4 aliased DBs).
//   4. stale user-facing rows (notification / mail-automation) are retired, not delivered,
//      so a recovered drain never mails/pushes people about weeks-old events; internal
//      idempotent topics (audit) are still delivered however old.
//   5. a poison row goes terminal `failed` and does not block the rows behind it.
import { describe, it, expect } from "vitest";
import type { D1Database, DurableObjectState } from "@cloudflare/workers-types";
import { drain } from "@dub/freeq";
import { FreeqDrainDO, DRAIN_INTERVAL_MS, OVERDUE_ALARM_MS, LAST_TICK_KEY } from "../src/drain-do";
import { DRAIN_OPTS, FREE_PLAN_SUBREQUEST_CAP, drainAll, worstCaseSubrequestsPerTick } from "../src/drain-all";
import { OUTBOX_DB_BINDINGS, type Env } from "../src/env";
import { expireStale, makeDeliver, NOTIFICATION_MAX_AGE_MS, MAIL_AUTOMATION_MAX_AGE_MS } from "../src/routing";
import { makeD1, fakeSvc, seed, readRow } from "./d1";

function fakeState(opts: { failSetAlarmTimes?: number } = {}) {
  let alarm: number | null = null;
  let setAlarmFailures = opts.failSetAlarmTimes ?? 0;
  const kv = new Map<string, unknown>();
  const state = {
    storage: {
      async getAlarm() {
        return alarm;
      },
      async setAlarm(t: number) {
        if (setAlarmFailures > 0) {
          setAlarmFailures--;
          throw new Error("storage hiccup");
        }
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
  return { state, kv, getAlarm: () => alarm, setAlarmRaw: (t: number | null) => void (alarm = t) };
}

const throwingDb = {
  prepare() {
    throw new Error("D1 exploded");
  },
} as unknown as D1Database;

describe("alarm() never throws and always re-arms (2026-09-21 stall)", () => {
  it("survives an env whose every access throws, and still leaves a pending alarm", async () => {
    const fs = fakeState();
    const env = new Proxy({} as Env, {
      get() {
        throw new Error("env exploded");
      },
    });
    await expect(new FreeqDrainDO(fs.state, env).alarm()).resolves.toBeUndefined();
    expect(fs.getAlarm()).not.toBeNull();
  });

  it("re-arms in finally when the up-front setAlarm fails", async () => {
    const fs = fakeState({ failSetAlarmTimes: 1 });
    await expect(new FreeqDrainDO(fs.state, { DB_CORE: throwingDb } as unknown as Env).alarm()).resolves.toBeUndefined();
    expect(fs.getAlarm()).not.toBeNull();
  });

  it("records the last successful tick", async () => {
    const fs = fakeState();
    await new FreeqDrainDO(fs.state, {} as Env).alarm();
    expect(fs.kv.get(LAST_TICK_KEY)).toBeTypeOf("number");
  });
});

describe("ensureAlarm / kick (cron backstop target)", () => {
  it("re-arms a DROPPED alarm (none pending)", async () => {
    const fs = fakeState();
    const at = await new FreeqDrainDO(fs.state, {} as Env).ensureAlarm();
    expect(fs.getAlarm()).toBe(at);
  });

  it("re-arms a WEDGED alarm that is long overdue, to fire almost immediately", async () => {
    const fs = fakeState();
    fs.setAlarmRaw(Date.now() - OVERDUE_ALARM_MS - 60_000);
    const before = Date.now();
    const at = await new FreeqDrainDO(fs.state, {} as Env).ensureAlarm();
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThan(before + DRAIN_INTERVAL_MS);
    expect(fs.getAlarm()).toBe(at);
  });

  it("leaves a healthy pending alarm untouched", async () => {
    const fs = fakeState();
    const healthy = Date.now() + 30_000;
    fs.setAlarmRaw(healthy);
    expect(await new FreeqDrainDO(fs.state, {} as Env).ensureAlarm()).toBe(healthy);
    expect(fs.getAlarm()).toBe(healthy);
  });
});

describe("Free-plan subrequest budget", () => {
  it("drains one entry per PHYSICAL D1 (dub-core aliases are not re-drained)", () => {
    expect([...OUTBOX_DB_BINDINGS]).toEqual(["DB_CORE", "DB_AUTH"]);
  });
  it("worst-case subrequests per tick stay under the 50 cap", () => {
    expect(worstCaseSubrequestsPerTick()).toBeLessThanOrEqual(FREE_PLAN_SUBREQUEST_CAP);
  });
  it("a tick claims at most batchSize rows per DB", async () => {
    const core = makeD1();
    for (let i = 0; i < DRAIN_OPTS.batchSize + 7; i++) seed(core.raw, `a${String(i).padStart(3, "0")}`, "audit.record", { i });
    const audit = fakeSvc(200);
    const out = await drainAll({ DB_CORE: core.d1, SVC_AUDIT_LOG: audit.svc } as unknown as Env);
    expect(out.DB_CORE).toMatchObject({ ok: true, claimed: DRAIN_OPTS.batchSize });
    expect(audit.calls).toHaveLength(DRAIN_OPTS.batchSize);
  });
});

describe("stale user-facing rows are retired, not delivered", () => {
  const now = Date.parse("2026-11-25T03:00:00.000Z");
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

  it("expireStale: TTL only on user-facing topics", () => {
    expect(expireStale({ topic: "evt.notification", created_at: iso(NOTIFICATION_MAX_AGE_MS + 1) }, now)).toMatch(/stale/);
    expect(expireStale({ topic: "evt.notification", created_at: iso(60_000) }, now)).toBeNull();
    expect(expireStale({ topic: "evt.mail-automation", created_at: iso(MAIL_AUTOMATION_MAX_AGE_MS + 1) }, now)).toMatch(/stale/);
    expect(expireStale({ topic: "audit.record", created_at: "2026-09-22T00:00:00.000Z" }, now)).toBeNull();
    expect(expireStale({ topic: "evt.gantt", created_at: "2026-09-22T00:00:00.000Z" }, now)).toBeNull();
    expect(expireStale({ topic: "evt.notification", created_at: "garbage" }, now)).toBeNull();
  });

  it("drainAll: a September notification / auto-reply is NOT sent; September audit IS ingested", async () => {
    const core = makeD1();
    const notif = fakeSvc(200);
    const mailAuto = fakeSvc(200);
    const audit = fakeSvc(200);
    seed(core.raw, "n-old", "evt.notification", { id: "n1", name: "task.assigned" }, "2026-09-22T00:00:00.000Z");
    seed(core.raw, "m-old", "evt.mail-automation", { id: "m1", name: "mail.message.received" }, "2026-09-22T00:00:00.000Z");
    seed(core.raw, "a-old", "audit.record", { id: "a1" }, "2026-09-22T00:00:00.000Z");
    seed(core.raw, "n-new", "evt.notification", { id: "n2", name: "task.assigned" }, new Date().toISOString());

    await drainAll({ DB_CORE: core.d1, SVC_NOTIFICATION: notif.svc, SVC_MAIL_AUTOMATION: mailAuto.svc, SVC_AUDIT_LOG: audit.svc } as unknown as Env);

    expect(readRow(core.raw, "n-old")).toMatchObject({ status: "failed" });
    expect(readRow(core.raw, "n-old")!.last_error).toMatch(/^expired: /);
    expect(readRow(core.raw, "m-old")).toMatchObject({ status: "failed" });
    expect(mailAuto.calls).toHaveLength(0);
    expect(notif.calls).toHaveLength(1); // only the fresh one
    expect(readRow(core.raw, "n-new")).toMatchObject({ status: "done" });
    expect(readRow(core.raw, "a-old")).toMatchObject({ status: "done" });
    expect(audit.calls).toHaveLength(1);
  });
});

describe("poison row cannot block the queue", () => {
  it("unparseable payload goes terminal failed after maxAttempts while healthy rows keep flowing", async () => {
    const { d1, raw } = makeD1();
    raw
      .prepare(
        `INSERT INTO freeq_outbox (id, topic, payload, status, attempts, next_attempt_at, created_at, last_error)
         VALUES ('poison', 'audit.record', '{not json', 'pending', 0, '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', NULL)`,
      )
      .run();
    const audit = fakeSvc(200);
    const env = { SVC_AUDIT_LOG: audit.svc } as unknown as Env;
    let t = Date.parse("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < DRAIN_OPTS.maxAttempts + 2; i++) {
      seed(raw, `ok${i}`, "audit.record", { i });
      await drain(d1, makeDeliver(env), { ...DRAIN_OPTS, now: () => t });
      expect(readRow(raw, `ok${i}`)).toMatchObject({ status: "done" }); // never blocked
      t += 2 * 60 * 60 * 1000;
    }
    expect(readRow(raw, "poison")).toMatchObject({ status: "failed", attempts: DRAIN_OPTS.maxAttempts });
  });
});
