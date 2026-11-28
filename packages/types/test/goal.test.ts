import { describe, expect, it } from "vitest";
import { goal } from "../src/index";

describe("goal", () => {
  it("floors a KPI percent and allows going past 100", () => {
    expect(goal.kpiPercent(1, 3)).toBe(33);
    expect(goal.kpiPercent(199, 200)).toBe(99);
    expect(goal.kpiPercent(29, 100)).toBe(29);
    expect(goal.kpiPercent(15, 10)).toBe(150);
    expect(goal.kpiPercent(null, 10)).toBeNull();
  });

  it("caps each KPI at 100 in the team percent and skips the uncountable", () => {
    expect(goal.goalPercent([{ percent: 200 }, { percent: 0 }])).toBe(50);
    expect(goal.goalPercent([{ percent: 40 }, { percent: null }])).toBe(40);
    expect(goal.goalPercent([{ percent: null }])).toBeNull();
    expect(goal.goalPercent([])).toBeNull();
  });

  it("calls a goal achieved only when every KPI was counted and reached", () => {
    const ok = { status: "ok" as const, percent: 100 };
    expect(goal.isAchieved({ percent: 100, kpis: [ok] as never })).toBe(true);
    expect(goal.isAchieved({ percent: 100, kpis: [ok, { status: "unavailable", percent: null }] as never })).toBe(false);
    expect(goal.isAchieved({ percent: 99, kpis: [ok] as never })).toBe(false);
  });

  it("uses the JST calendar for months", () => {
    expect(goal.currentMonth(new Date("2026-11-30T14:59:59Z"))).toBe("2026-11");
    expect(goal.currentMonth(new Date("2026-11-30T15:00:00Z"))).toBe("2026-12");
    expect(goal.shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(goal.shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(goal.daysInMonth("2028-02")).toBe(29);
  });

  it("counts elapsed days for past, current and future months", () => {
    const now = new Date("2026-11-06T03:00:00Z");
    expect(goal.elapsedDays("2026-10", now)).toBe(31);
    expect(goal.elapsedDays("2026-11", now)).toBe(6);
    expect(goal.elapsedDays("2026-12", now)).toBe(0);
  });

  it("builds the sponsor tab month from every team's KPIs, one entry per sponsor metric", () => {
    const kpi = (metric: goal.GoalMetric, target: number) => ({ metric, target });
    const m = goal.sponsorTabMonthOf(
      "2026-11",
      [kpi("sponsor_contacted", 10), kpi("tasks_done", 99), kpi("sponsor_cards", 20), kpi("sponsor_contacted", 15), kpi("sponsor_agreed", 3)],
      { sponsor_contacted: 6, sponsor_cards: 20, sponsor_agreed: 0, sponsor_proposed: 2, sponsor_amount: 0 },
    );
    expect(m.metrics.map((x) => x.metric)).toEqual(["sponsor_cards", "sponsor_contacted", "sponsor_proposed", "sponsor_agreed", "sponsor_amount"]);
    expect(m.metrics.find((x) => x.metric === "sponsor_contacted")).toEqual({ metric: "sponsor_contacted", target: 15, actual: 6, percent: 40 });
    expect(m.metrics.find((x) => x.metric === "sponsor_cards")?.percent).toBe(100);
    expect(m.metrics.find((x) => x.metric === "sponsor_proposed")).toEqual({ metric: "sponsor_proposed", target: null, actual: 2, percent: null });
    expect(goal.sponsorTabMonthOf("2026-11", [kpi("sponsor_amount", 500)], null).metrics.find((x) => x.metric === "sponsor_amount"))
      .toEqual({ metric: "sponsor_amount", target: 500, actual: null, percent: null });
  });

  it("lists months between two months, newest first", () => {
    expect(goal.monthsBetween("2026-11", "2027-02")).toEqual(["2027-02", "2027-01", "2026-12", "2026-11"]);
    expect(goal.monthsBetween("2026-11", "2026-11")).toEqual(["2026-11"]);
    expect(goal.monthsBetween("2026-12", "2026-11")).toEqual([]);
  });

  it("validates months", () => {
    expect(goal.isMonth("2026-11")).toBe(true);
    expect(goal.isMonth("2026-13")).toBe(false);
    expect(goal.isMonth("2026-1")).toBe(false);
  });
});
