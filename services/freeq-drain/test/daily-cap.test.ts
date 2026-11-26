// #841 daily write guard: the drain claims at most FREEQ_DAILY_ROW_CAP rows per UTC day.
// A backlog beyond the cap stays `pending` (never expired / failed) and resumes after the
// UTC day rolls over (= D1's 09:00 JST reset). Fake clock via vi.setSystemTime.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DurableObjectState } from "@cloudflare/workers-types";
import {
  DAILY_USAGE_KEY,
  DEFAULT_DAILY_ROW_CAP,
  parseDailyRowCap,
  recordUsage,
  remainingToday,
  utcDay,
} from "../src/daily-cap";
import { drainAll } from "../src/drain-all";
import { FreeqDrainDO } from "../src/drain-do";
import type { Env } from "../src/env";
import { fakeSvc, makeD1, readRow, seed } from "./d1";

function fakeState(): { state: DurableObjectState; kv: Map<string, unknown> } {
  let alarm: number | null = null;
  const kv = new Map<string, unknown>();
  const state = {
    storage: {
      getAlarm: async () => alarm,
      setAlarm: async (t: number) => {
        alarm = t;
      },
      deleteAlarm: async () => {
        alarm = null;
      },
      get: async <T>(k: string) => kv.get(k) as T | undefined,
      put: async <T>(k: string, v: T) => {
        kv.set(k, v);
      },
    },
  } as unknown as DurableObjectState;
  return { state, kv };
}

function statusCounts(raw: ReturnType<typeof makeD1>["raw"]): Record<string, number> {
  const rows = raw.prepare(`SELECT status, COUNT(*) AS n FROM freeq_outbox GROUP BY status`).all() as {
    status: string;
    n: number;
  }[];
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}

describe("parseDailyRowCap", () => {
  it("defaults when unset / blank / invalid / negative, floors numbers, allows 0", () => {
    expect(parseDailyRowCap(undefined)).toBe(DEFAULT_DAILY_ROW_CAP);
    expect(parseDailyRowCap("")).toBe(DEFAULT_DAILY_ROW_CAP);
    expect(parseDailyRowCap("abc")).toBe(DEFAULT_DAILY_ROW_CAP);
    expect(parseDailyRowCap("-5")).toBe(DEFAULT_DAILY_ROW_CAP);
    expect(parseDailyRowCap("250.9")).toBe(250);
    expect(parseDailyRowCap("0")).toBe(0);
  });
});

describe("daily usage counter (UTC day window)", () => {
  it("accumulates within a UTC day and resets at 00:00Z (09:00 JST)", async () => {
    const { state } = fakeState();
    const t0 = Date.parse("2026-11-26T23:59:00.000Z");
    expect(utcDay(t0)).toBe("2026-11-26");
    await recordUsage(state.storage, 7, t0);
    await recordUsage(state.storage, 3, t0);
    expect(await remainingToday(state.storage, 12, t0)).toBe(2);
    expect(await remainingToday(state.storage, 5, t0)).toBe(0); // never negative
    const t1 = Date.parse("2026-11-27T00:00:00.000Z");
    expect(await remainingToday(state.storage, 12, t1)).toBe(12);
  });
});

describe("drainAll maxRows", () => {
  it("claims no more than maxRows across DBs; later DBs are capped, rows stay pending", async () => {
    const core = makeD1();
    const auth = makeD1();
    for (let i = 0; i < 6; i++) seed(core.raw, `c${i}`, "audit.record", { i });
    for (let i = 0; i < 3; i++) seed(auth.raw, `a${i}`, "audit.record", { i });
    const audit = fakeSvc(200);
    const env = { DB_CORE: core.d1, DB_AUTH: auth.d1, SVC_AUDIT_LOG: audit.svc } as unknown as Env;

    const res = await drainAll(env, { maxRows: 4 });

    expect(res.DB_CORE).toMatchObject({ ok: true, claimed: 4, delivered: 4, capped: true });
    expect(res.DB_AUTH).toMatchObject({ ok: true, claimed: 0, capped: true });
    expect(statusCounts(core.raw)).toEqual({ done: 4, pending: 2 });
    expect(statusCounts(auth.raw)).toEqual({ pending: 3 });
    expect(audit.calls).toHaveLength(4);
  });

  it("without maxRows keeps the existing per-DB batch behaviour (no capped flag)", async () => {
    const core = makeD1();
    seed(core.raw, "c0", "audit.record", {});
    const env = { DB_CORE: core.d1, SVC_AUDIT_LOG: fakeSvc(200).svc } as unknown as Env;
    const res = await drainAll(env);
    expect(res.DB_CORE).toEqual({ ok: true, claimed: 1, delivered: 1, retried: 0, failed: 0 });
  });
});

describe("FreeqDrainDO.alarm daily cap (fake clock)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops at the cap for the day, keeps the backlog pending, resumes after the UTC reset", async () => {
    const core = makeD1();
    for (let i = 0; i < 25; i++) seed(core.raw, `c${String(i).padStart(2, "0")}`, "audit.record", { i });
    const audit = fakeSvc(200);
    const env = {
      DB_CORE: core.d1,
      SVC_AUDIT_LOG: audit.svc,
      FREEQ_DAILY_ROW_CAP: "12",
    } as unknown as Env;
    const fs = fakeState();
    const dobj = new FreeqDrainDO(fs.state, env);

    // Day 1 (UTC): many ticks, but only 12 rows may be claimed in total.
    vi.setSystemTime(new Date("2026-11-26T01:00:00.000Z"));
    for (let tick = 0; tick < 5; tick++) {
      await dobj.alarm();
      vi.setSystemTime(Date.now() + 60_000);
    }
    expect(statusCounts(core.raw)).toEqual({ done: 12, pending: 13 });
    expect(audit.calls).toHaveLength(12);
    expect(fs.kv.get(DAILY_USAGE_KEY)).toEqual({ day: "2026-11-26", used: 12 });
    // the backlog beyond the cap is untouched: still pending, never attempted / expired
    expect(readRow(core.raw, "c24")).toMatchObject({ status: "pending", attempts: 0, last_error: null });

    // Day 2 after the reset (00:00Z = 09:00 JST): the budget is fresh.
    vi.setSystemTime(new Date("2026-11-27T00:00:30.000Z"));
    for (let tick = 0; tick < 5; tick++) {
      await dobj.alarm();
      vi.setSystemTime(Date.now() + 60_000);
    }
    // (asserted via deliveries: the 6h retention pass may prune old `done` rows by now)
    expect(audit.calls).toHaveLength(24);
    expect(statusCounts(core.raw).pending).toBe(1);

    // Day 3: the rest drains.
    vi.setSystemTime(new Date("2026-11-28T00:00:30.000Z"));
    await dobj.alarm();
    expect(audit.calls).toHaveLength(25);
    expect(statusCounts(core.raw).pending).toBeUndefined();
  });

  it("cap 0 pauses delivery without touching any row", async () => {
    const core = makeD1();
    seed(core.raw, "c0", "audit.record", {});
    const audit = fakeSvc(200);
    const env = { DB_CORE: core.d1, SVC_AUDIT_LOG: audit.svc, FREEQ_DAILY_ROW_CAP: "0" } as unknown as Env;
    vi.setSystemTime(new Date("2026-11-26T01:00:00.000Z"));
    await new FreeqDrainDO(fakeState().state, env).alarm();
    expect(audit.calls).toHaveLength(0);
    expect(readRow(core.raw, "c0")).toMatchObject({ status: "pending", attempts: 0 });
  });
});
