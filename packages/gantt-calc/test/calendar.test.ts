import { describe, it, expect } from "vitest";
import type { ganttCalc } from "@dub/types";
import { createWorkCalendar, dayOfWeek, computeRollup, computeCriticalPath } from "../src/index";

// Day 0 = 1970-01-01 (Thu). day1 Fri, day2 Sat, day3 Sun, day4 Mon, day5 Tue.

describe("dayOfWeek", () => {
  it("maps the epoch to Thursday and handles negatives", () => {
    expect(dayOfWeek(0)).toBe(4); // Thu
    expect(dayOfWeek(2)).toBe(6); // Sat
    expect(dayOfWeek(3)).toBe(0); // Sun
    expect(dayOfWeek(-1)).toBe(3); // Wed
  });
});

describe("createWorkCalendar — default Sat/Sun weekend", () => {
  const cal = createWorkCalendar();

  it("recognises weekends as non-working", () => {
    expect(cal.isWorkingDay(0)).toBe(true); // Thu
    expect(cal.isWorkingDay(2)).toBe(false); // Sat
    expect(cal.isWorkingDay(3)).toBe(false); // Sun
    expect(cal.isWorkingDay(4)).toBe(true); // Mon
  });

  it("nextWorkingDay jumps over the weekend", () => {
    expect(cal.nextWorkingDay(2)).toBe(4); // Sat -> Mon
    expect(cal.nextWorkingDay(4)).toBe(4); // already working
  });

  it("addWorkingDays advances by working days, skipping weekends", () => {
    expect(cal.addWorkingDays(0, 1)).toBe(1); // Thu -> Fri
    expect(cal.addWorkingDays(0, 2)).toBe(4); // Thu -> Mon (skips Sat/Sun)
    expect(cal.addWorkingDays(1, 1)).toBe(4); // Fri -> Mon
    expect(cal.addWorkingDays(0, 0)).toBe(0); // no move
  });

  it("addWorkingDays snaps a non-working start forward first", () => {
    expect(cal.addWorkingDays(2, 0)).toBe(4); // Sat -> Mon
    expect(cal.addWorkingDays(2, 1)).toBe(5); // Sat -> (Mon) -> Tue
  });

  it("countWorkingDays counts a half-open range", () => {
    expect(cal.countWorkingDays(0, 7)).toBe(5); // one week = 5 working days
    expect(cal.countWorkingDays(0, 5)).toBe(3); // Thu,Fri,Mon
    expect(cal.countWorkingDays(4, 4)).toBe(0);
  });

  it("toOrdinal/fromOrdinal round-trip on working days", () => {
    for (const w of [0, 1, 4, 5, 8]) {
      expect(cal.isWorkingDay(w)).toBe(true);
      expect(cal.fromOrdinal(cal.toOrdinal(w))).toBe(w);
    }
    for (let o = 0; o < 12; o++) {
      expect(cal.toOrdinal(cal.fromOrdinal(o))).toBe(o);
    }
  });
});

describe("createWorkCalendar — holidays", () => {
  // Friday 1970-01-02 (day 1) is a holiday.
  const cal = createWorkCalendar({ holidays: ["1970-01-02"] });

  it("treats the holiday as non-working", () => {
    expect(cal.isWorkingDay(1)).toBe(false);
    expect(cal.nextWorkingDay(1)).toBe(4); // Fri(holiday)/Sat/Sun -> Mon
  });

  it("skips the holiday when counting and adding working days", () => {
    expect(cal.countWorkingDays(0, 7)).toBe(4); // week minus the Friday holiday
    expect(cal.addWorkingDays(0, 1)).toBe(4); // Thu -> Mon (Fri holiday skipped)
  });

  it("ignores a holiday that falls on a weekend (no double count)", () => {
    const c2 = createWorkCalendar({ holidays: ["1970-01-03"] }); // Sat
    expect(c2.countWorkingDays(0, 7)).toBe(5);
  });
});

describe("createWorkCalendar — custom weekend", () => {
  // Friday(5) + Saturday(6) weekend.
  const cal = createWorkCalendar({ weekendDays: [5, 6] });

  it("honours the custom weekend days", () => {
    expect(cal.isWorkingDay(1)).toBe(false); // Fri
    expect(cal.isWorkingDay(2)).toBe(false); // Sat
    expect(cal.isWorkingDay(3)).toBe(true); // Sun now a working day
    expect(cal.nextWorkingDay(1)).toBe(3); // Fri/Sat -> Sun
    expect(cal.countWorkingDays(0, 7)).toBe(5);
  });
});

describe("computeRollup with a WorkCalendar", () => {
  const t = (id: string, durationDays: number, startsAt: string | null = null): ganttCalc.GanttCalcTask => ({
    id,
    startsAt,
    endsAt: null,
    durationDays,
  });
  const dep = (taskId: string, dependsOnId: string): ganttCalc.GanttCalcDependency => ({ taskId, dependsOnId });

  it("rolls durations forward in working days, skipping the weekend", () => {
    const cal = createWorkCalendar();
    const res = computeRollup(
      { tasks: [t("a", 3, "1970-01-01T00:00:00Z"), t("b", 1)], dependencies: [dep("b", "a")] },
      { calendar: cal },
    );
    // a: 3 working days from Thu -> finishes at Tue (day5); b: +1 wd -> Wed (day6)
    expect(res.earliestStart["a"]).toBe("1970-01-01T00:00:00.000Z"); // Thu
    expect(res.earliestStart["b"]).toBe("1970-01-06T00:00:00.000Z"); // Tue (day5)
    expect(res.latestFinish["b"]).toBe("1970-01-07T00:00:00.000Z"); // Wed (day6)
  });

  it("differs from the calendar-day rollup by pushing past the weekend", () => {
    const req = { tasks: [t("a", 3, "1970-01-01T00:00:00Z"), t("b", 1)], dependencies: [dep("b", "a")] };
    const plain = computeRollup(req);
    const withCal = computeRollup(req, { calendar: createWorkCalendar() });
    expect(plain.earliestStart["b"]).toBe("1970-01-04T00:00:00.000Z"); // Sun (no skip)
    expect(withCal.earliestStart["b"]).toBe("1970-01-06T00:00:00.000Z"); // Tue (weekend skipped)
  });

  it("critical path totals in working days under a calendar", () => {
    const res = computeCriticalPath(
      { tasks: [t("a", 3, "1970-01-01T00:00:00Z"), t("b", 1)], dependencies: [dep("b", "a")] },
      { calendar: createWorkCalendar() },
    );
    expect(res.criticalTaskIds).toEqual(["a", "b"]);
    expect(res.totalDurationDays).toBe(4); // 3 + 1 working days
  });
});
