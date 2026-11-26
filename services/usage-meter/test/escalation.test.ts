import { describe, it, expect } from "vitest";
import { levelFor, projectUsage, projectionBasis, LEVEL_PCT } from "../src/escalation";
import { MASTER, MASTER_BY_KEY } from "../src/limits";
import { PLAYBOOK_KEYS, playbookFor } from "../src/playbook";
import { buildSummary } from "../src/summary";

const D1_READ = MASTER_BY_KEY.get("d1_rows_read_day")!;
const R2_STORE = MASTER_BY_KEY.get("r2_storage")!;

describe("levelFor", () => {
  const at = new Date("2026-11-27T12:00:00Z");
  it("maps pct to warn 70 / act 85 / critical 95", () => {
    expect(LEVEL_PCT).toEqual({ warn: 70, act: 85, critical: 95 });
    expect(levelFor(69.9, null, at)).toBe("ok");
    expect(levelFor(70, null, at)).toBe("warn");
    expect(levelFor(85, null, at)).toBe("act");
    expect(levelFor(95, null, at)).toBe("critical");
    expect(levelFor(null, null, at)).toBe("unknown");
  });
  it("raises to warn when the window pace runs out before the reset", () => {
    const p = projectUsage(D1_READ, 3_000_000, at); // 60% at noon -> 120% by midnight
    expect(p?.exhaustsAt).toBe("2026-11-27T20:00:00.000Z");
    expect(p?.pctAtReset).toBe(120);
    expect(levelFor(60, p, at)).toBe("warn");
  });
  it("raises storage that fills within 7 days to act", () => {
    const limit = R2_STORE.limit;
    const used = limit * 0.6;
    const p = projectUsage(R2_STORE, used, at, [{ day: "2026-11-24", used: used - limit * 0.3 }]);
    expect(p?.basis).toBe("growth");
    expect(p?.exhaustsAt).not.toBeNull();
    expect(levelFor(60, p, at)).toBe("act");
  });
});

describe("projectUsage", () => {
  it("skips the first 3 hours of a daily window (too noisy)", () => {
    expect(projectUsage(D1_READ, 10, new Date("2026-11-27T02:00:00Z"))).toBeNull();
  });
  it("returns no exhaustion when the pace stays under the limit", () => {
    const p = projectUsage(D1_READ, 1_000_000, new Date("2026-11-27T12:00:00Z"));
    expect(p?.exhaustsAt).toBeNull();
    expect(p?.pctAtReset).toBe(40);
  });
  it("needs history for storage and reports a flat trend as not exhausting", () => {
    const at = new Date("2026-11-27T12:00:00Z");
    expect(projectUsage(R2_STORE, 100, at)).toBeNull();
    expect(projectUsage(R2_STORE, 100, at, [{ day: "2026-11-20", used: 100 }])?.exhaustsAt).toBeNull();
  });
  it("has no projection for per-minute peaks", () => {
    expect(projectionBasis(MASTER_BY_KEY.get("gcp_calendar_requests_peak_minute")!)).toBeNull();
  });
});

describe("playbook coverage", () => {
  it("every guarded metric has its own playbook + paid price", () => {
    for (const def of MASTER) {
      expect(PLAYBOOK_KEYS, def.metricKey).toContain(def.metricKey);
      expect(playbookFor(def.metricKey).paid.price.length).toBeGreaterThan(0);
    }
  });
});

describe("buildSummary escalation fields", () => {
  it("adds level, projection, playbook, paid plan and issue search per metric", () => {
    const now = new Date("2026-11-27T12:00:00Z");
    const summary = buildSummary(
      [{ provider: "cloudflare", metric_key: "d1_rows_read_day", label: "x", used: 4_400_000, limit_value: 5_000_000, pct: 88, unit: "rows/day", overflow_behavior: "halt", status: "warn", captured_at: now.toISOString() }],
      now,
      now.toISOString(),
    );
    const s = summary.services.find((x) => x.metricKey === "d1_rows_read_day")!;
    expect(s.status).toBe("warn"); // frozen 70/90 status unchanged
    expect(s.level).toBe("act");
    expect(s.projection?.basis).toBe("window");
    expect(s.playbookUrl).toMatch(/11-usage-free-tier\/d1-rows-read\.md$/);
    expect(s.paidPlan.name).toBe("Workers Paid");
    expect(decodeURIComponent(s.issueSearchUrl)).toContain('"[usage:d1_rows_read_day]"');
    expect(summary.worstLevel).toBe("act");
  });
});
