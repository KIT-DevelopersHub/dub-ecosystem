// Dashboard model unit tests: the threshold/status mapping and the derived figures
// (countdown, completion, worst free-tier) that the KPI row reads. Pure, no DOM.
import { describe, expect, it } from "vitest";
import {
  CRITICAL_PCT,
  FREE_TIER,
  TASK_SEGMENTS,
  WARN_PCT,
  clampPct,
  daysUntil,
  statusMeta,
  taskCompletionPct,
  taskTotal,
  usageStatusFromPct,
  worstFreeTier,
} from "./dashboardData.ts";

describe("clampPct", () => {
  it("clamps out-of-range and non-finite to 0–100", () => {
    expect(clampPct(-5)).toBe(0);
    expect(clampPct(140)).toBe(100);
    expect(clampPct(Number.NaN)).toBe(0);
    expect(clampPct(42.5)).toBe(42.5);
  });
});

describe("usageStatusFromPct", () => {
  it("maps at the warn/critical boundaries", () => {
    expect(usageStatusFromPct(0)).toBe("good");
    expect(usageStatusFromPct(WARN_PCT - 0.1)).toBe("good");
    expect(usageStatusFromPct(WARN_PCT)).toBe("warn");
    expect(usageStatusFromPct(CRITICAL_PCT - 0.1)).toBe("warn");
    expect(usageStatusFromPct(CRITICAL_PCT)).toBe("critical");
    expect(usageStatusFromPct(Number.NaN)).toBe("info");
  });
});

describe("statusMeta", () => {
  it("pairs every status with a tone, label and token color path", () => {
    for (const s of ["good", "warn", "critical", "info"] as const) {
      const m = statusMeta(s);
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.colorPath).toMatch(/^color\./);
      expect(m.softColorPath).toMatch(/^color\./);
    }
    expect(statusMeta("critical").tone).toBe("danger");
    expect(statusMeta("good").tone).toBe("success");
  });
});

describe("daysUntil", () => {
  it("rounds up whole days to the target and never goes negative", () => {
    const now = new Date("2026-08-16T00:00:00Z");
    expect(daysUntil("2026-08-22T00:00:00Z", now)).toBe(6);
    expect(daysUntil("2026-08-16T05:00:00Z", now)).toBe(1);
    expect(daysUntil("2026-08-10T00:00:00Z", now)).toBe(0); // past → 0
  });
  it("returns null on an invalid date", () => {
    expect(daysUntil("not-a-date")).toBeNull();
  });
});

describe("task breakdown", () => {
  it("totals the segments and derives the completion percentage from 完了", () => {
    expect(taskTotal()).toBe(TASK_SEGMENTS.reduce((n, s) => n + s.count, 0));
    const done = TASK_SEGMENTS.find((s) => s.key === "done")!.count;
    expect(taskCompletionPct()).toBeCloseTo((done / taskTotal()) * 100, 5);
  });
  it("is 0% for an empty set", () => {
    expect(taskCompletionPct([])).toBe(0);
    expect(taskTotal([])).toBe(0);
  });
});

describe("worstFreeTier", () => {
  it("returns the single most-stressed metric", () => {
    const worst = worstFreeTier();
    for (const m of FREE_TIER) expect(worst.pct).toBeGreaterThanOrEqual(m.pct);
  });
});
