import { describe, expect, it } from "vitest";
import { goal } from "../src/index";

describe("goal", () => {
  it("rounds a KPI percent and allows going past 100", () => {
    expect(goal.kpiPercent(1, 3)).toBe(33);
    expect(goal.kpiPercent(15, 10)).toBe(150);
    expect(goal.kpiPercent(null, 10)).toBeNull();
  });

  it("caps each KPI at 100 in the team percent and skips the uncountable", () => {
    expect(goal.goalPercent([{ percent: 200 }, { percent: 0 }])).toBe(50);
    expect(goal.goalPercent([{ percent: 40 }, { percent: null }])).toBe(40);
    expect(goal.goalPercent([{ percent: null }])).toBeNull();
    expect(goal.goalPercent([])).toBeNull();
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

  it("validates months", () => {
    expect(goal.isMonth("2026-11")).toBe(true);
    expect(goal.isMonth("2026-13")).toBe(false);
    expect(goal.isMonth("2026-1")).toBe(false);
  });
});
