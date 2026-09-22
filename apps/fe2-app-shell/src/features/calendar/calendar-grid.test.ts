import { describe, it, expect } from "vitest";
import type { task } from "@dub/types";
import {
  addMonths,
  buildMonthGrid,
  buildWeekGrid,
  dayKey,
  formatMonthLabel,
  groupTasksByDay,
  isoToUtcDay,
  startOfMonth,
  startOfWeek,
} from "./calendar-grid";

function mkTask(over: Partial<task.Task> & { id: string; title: string }): task.Task {
  return {
    eventId: null,
    description: null,
    status: "todo",
    priority: "medium",
    assigneeId: null,
    startAt: null,
    dueAt: null,
    origin: "internal",
    archivedAt: null,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    version: 1,
    ...over,
  } as task.Task;
}

describe("month grid", () => {
  it("is always 42 cells (6 weeks) and starts on a Sunday", () => {
    const grid = buildMonthGrid(new Date(Date.UTC(2026, 7, 15)));
    expect(grid).toHaveLength(42);
    expect(grid[0]!.date.getUTCDay()).toBe(0);
  });

  it("flags in-month days and leading/trailing spill", () => {
    // Aug 2026: Aug 1 is a Saturday, so the grid leads with July spill.
    const grid = buildMonthGrid(new Date(Date.UTC(2026, 7, 1)));
    const aug1 = grid.find((c) => c.key === "2026-08-01")!;
    expect(aug1.inMonth).toBe(true);
    expect(grid[0]!.inMonth).toBe(false); // July spill
    expect(grid[0]!.key).toBe("2026-07-26");
  });

  it("marks today", () => {
    const today = new Date(Date.UTC(2026, 7, 10));
    const grid = buildMonthGrid(today, today);
    expect(grid.find((c) => c.isToday)!.key).toBe("2026-08-10");
  });
});

describe("navigation helpers", () => {
  it("startOfMonth / addMonths anchor to the 1st", () => {
    const anchor = new Date(Date.UTC(2026, 7, 20));
    expect(dayKey(startOfMonth(anchor))).toBe("2026-08-01");
    expect(dayKey(addMonths(anchor, 1))).toBe("2026-09-01");
    expect(dayKey(addMonths(new Date(Date.UTC(2026, 0, 15)), -1))).toBe("2025-12-01");
  });

  it("formatMonthLabel is Japanese", () => {
    expect(formatMonthLabel(new Date(Date.UTC(2026, 7, 1)))).toBe("2026年8月");
  });

  it("week grid is 7 cells from Sunday", () => {
    const wk = buildWeekGrid(new Date(Date.UTC(2026, 7, 5))); // Wed
    expect(wk).toHaveLength(7);
    expect(dayKey(startOfWeek(new Date(Date.UTC(2026, 7, 5))))).toBe("2026-08-02");
    expect(wk[0]!.key).toBe("2026-08-02");
  });
});

describe("grouping tasks onto days", () => {
  it("places a due-only task on its deadline day", () => {
    const { byDay } = groupTasksByDay([mkTask({ id: "t1", title: "A", dueAt: "2026-08-03T09:00:00Z" })]);
    expect(byDay.get("2026-08-03")).toHaveLength(1);
    expect(byDay.get("2026-08-03")![0]!.isSpan).toBe(false);
  });

  it("spans a task with both startAt and dueAt across every day inclusive", () => {
    const { byDay } = groupTasksByDay([
      mkTask({ id: "t2", title: "Span", startAt: "2026-08-01T00:00:00Z", dueAt: "2026-08-04T00:00:00Z" }),
    ]);
    expect([...byDay.keys()].sort()).toEqual(["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"]);
    expect(byDay.get("2026-08-01")![0]!.isStart).toBe(true);
    expect(byDay.get("2026-08-04")![0]!.isEnd).toBe(true);
    expect(byDay.get("2026-08-02")![0]).toMatchObject({ isStart: false, isEnd: false, isSpan: true });
  });

  it("returns dateless tasks as undated (never dropped)", () => {
    const { byDay, undated } = groupTasksByDay([mkTask({ id: "t3", title: "NoDate" })]);
    expect(byDay.size).toBe(0);
    expect(undated.map((t) => t.id)).toEqual(["t3"]);
  });

  it("excludes archived tasks", () => {
    const { byDay, undated } = groupTasksByDay([
      mkTask({ id: "t4", title: "Gone", dueAt: "2026-08-03T09:00:00Z", archivedAt: "2026-08-02T00:00:00Z" }),
    ]);
    expect(byDay.size).toBe(0);
    expect(undated).toHaveLength(0);
  });

  it("sorts spans before single-day tasks within a day", () => {
    const { byDay } = groupTasksByDay([
      mkTask({ id: "s1", title: "Zzz single", dueAt: "2026-08-03T09:00:00Z" }),
      mkTask({ id: "s2", title: "Aaa span", startAt: "2026-08-01T00:00:00Z", dueAt: "2026-08-05T00:00:00Z" }),
    ]);
    const day = byDay.get("2026-08-03")!;
    expect(day[0]!.isSpan).toBe(true);
    expect(day[1]!.isSpan).toBe(false);
  });
});

describe("isoToUtcDay", () => {
  it("normalizes to UTC midnight and handles null/invalid", () => {
    expect(dayKey(isoToUtcDay("2026-08-03T23:59:00Z")!)).toBe("2026-08-03");
    expect(isoToUtcDay(null)).toBeNull();
    expect(isoToUtcDay("not-a-date")).toBeNull();
  });
});
