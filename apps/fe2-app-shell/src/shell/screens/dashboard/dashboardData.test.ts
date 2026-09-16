// Dashboard model unit tests: the threshold/status mapping and the derived figures
// (countdown, completion, worst free-tier) that the KPI row reads. Pure, no DOM.
import { describe, expect, it } from "vitest";
import {
  CRITICAL_PCT,
  WARN_PCT,
  clampPct,
  daysUntil,
  eventDateLabel,
  freeTierFromMetrics,
  statusMeta,
  taskCompletionPct,
  taskSegmentsFromCounts,
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
  it("rounds up whole days remaining to a future target", () => {
    const now = new Date("2026-08-16T00:00:00Z");
    expect(daysUntil("2026-08-22T00:00:00Z", now)).toBe(6);
    expect(daysUntil("2026-08-16T05:00:00Z", now)).toBe(1);
  });
  it("is 0 exactly on the target and NEGATIVE once it has passed (never clamps to 0)", () => {
    // Regression: clamping a past date to 0 made an event that already happened look
    // identical to "happening today" — the dashboard's 開催まで tile got permanently
    // stuck at "0日" for a stale hardcoded date instead of ever reading "開催済み".
    // Callers now do their own subtraction-is-correct check on the sign.
    const now = new Date("2026-08-16T00:00:00Z");
    expect(daysUntil("2026-08-16T00:00:00Z", now)).toBe(0);
    expect(daysUntil("2026-08-10T00:00:00Z", now)).toBe(-6); // 6 days ago
    expect(daysUntil("2026-08-15T00:00:00Z", now)).toBe(-1); // yesterday
  });
  it("returns null on an invalid date", () => {
    expect(daysUntil("not-a-date")).toBeNull();
  });
});

describe("eventDateLabel", () => {
  it("formats a valid startsAt with the ja-JP locale", () => {
    expect(eventDateLabel("2026-08-22T01:00:00+09:00")).toBe(new Date("2026-08-22T01:00:00+09:00").toLocaleDateString("ja-JP"));
  });
  it("falls back to 日程未定 for null or an unparsable date", () => {
    expect(eventDateLabel(null)).toBe("日程未定");
    expect(eventDateLabel("not-a-date")).toBe("日程未定");
  });
});

describe("taskSegmentsFromCounts", () => {
  it("builds the four visible segments in order and excludes cancelled from the total", () => {
    const segments = taskSegmentsFromCounts({ done: 30, in_progress: 10, todo: 6, blocked: 2, cancelled: 9 });
    expect(segments.map((s) => s.key)).toEqual(["done", "in_progress", "todo", "blocked"]);
    // cancelled (9) is intentionally not part of the visible breakdown.
    expect(taskTotal(segments)).toBe(48);
    const done = segments.find((s) => s.key === "done")!.count;
    expect(taskCompletionPct(segments)).toBeCloseTo((done / 48) * 100, 5);
  });
  it("defaults missing statuses to 0 and is 0% for an empty set", () => {
    const segments = taskSegmentsFromCounts({});
    expect(taskTotal(segments)).toBe(0);
    expect(taskCompletionPct(segments)).toBe(0);
    expect(taskCompletionPct([])).toBe(0);
    expect(taskTotal([])).toBe(0);
  });
});

describe("free-tier projection", () => {
  it("maps null pct to 0 and sorts most-stressed first", () => {
    const metrics = freeTierFromMetrics([
      { key: "a", label: "A", pct: 12.3 },
      { key: "b", label: "B", pct: null },
      { key: "c", label: "C", pct: 88.0 },
    ]);
    expect(metrics.map((m) => m.key)).toEqual(["c", "a", "b"]);
    expect(metrics.find((m) => m.key === "b")!.pct).toBe(0);
  });
  it("worstFreeTier returns the single most-stressed metric, or null when empty", () => {
    const metrics = freeTierFromMetrics([
      { key: "a", label: "A", pct: 12.3 },
      { key: "c", label: "C", pct: 88.0 },
    ]);
    const worst = worstFreeTier(metrics);
    expect(worst?.key).toBe("c");
    for (const m of metrics) expect(worst!.pct).toBeGreaterThanOrEqual(m.pct);
    expect(worstFreeTier([])).toBeNull();
  });
});
