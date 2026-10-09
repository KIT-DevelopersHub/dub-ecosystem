// Pure model tests. Written timezone-agnostic: expectations are built with the local
// Date constructor, so they hold in JST locally and UTC in CI alike.
import { describe, expect, it } from "vitest";
import type { common, task } from "@dub/types";
import {
  dayFromKey,
  dayIndexOf,
  dayKeyOf,
  draftForAllDay,
  draftForSlot,
  draftFromItem,
  draftToDates,
  formatHourLabel,
  formatRangeTitle,
  itemsOnDay,
  layoutSpans,
  layoutTimedDay,
  monthGridDays,
  shiftAnchor,
  toCalendarItem,
  toCalendarItems,
  validateDraft,
  visibleDays,
  weekdayOf,
} from "./calendar-model";

function mk(id: string, over: Partial<task.Task> = {}): task.Task {
  return {
    id: id as common.TaskId,
    version: 1,
    title: id,
    description: null,
    status: "todo",
    priority: "medium",
    assigneeId: null,
    startAt: null,
    dueAt: null,
    origin: "internal",
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);
const day = (y: number, m: number, d: number) => dayIndexOf(local(y, m, d));

describe("day index helpers", () => {
  it("round-trips keys and weekdays", () => {
    const d = day(2026, 10, 10);
    expect(dayKeyOf(d)).toBe("2026-10-10");
    expect(dayFromKey("2026-10-10")).toBe(d);
    expect(weekdayOf(d)).toBe(6); // Saturday
  });

  it("week view starts on Sunday, month grid is 6 rows from the Sunday before the 1st", () => {
    const week = visibleDays("week", day(2026, 10, 10));
    expect(week.map(dayKeyOf)).toEqual([
      "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10",
    ]);
    const grid = monthGridDays(day(2026, 10, 10));
    expect(grid).toHaveLength(42);
    expect(dayKeyOf(grid[0]!)).toBe("2026-09-27");
  });

  it("shifts by the view's unit and clamps month ends", () => {
    expect(dayKeyOf(shiftAnchor("day", day(2026, 10, 10), 1))).toBe("2026-10-11");
    expect(dayKeyOf(shiftAnchor("week", day(2026, 10, 10), -1))).toBe("2026-10-03");
    expect(dayKeyOf(shiftAnchor("month", day(2026, 1, 31), 1))).toBe("2026-02-28");
  });
});

describe("toCalendarItem", () => {
  it("treats UTC-midnight dates (マイタスク's date-only values) as 終日 on that date", () => {
    const it1 = toCalendarItem(mk("a", { startAt: "2026-10-12T00:00:00.000Z", dueAt: "2026-10-14T00:00:00Z" }))!;
    expect(it1.allDay).toBe(true);
    expect(dayKeyOf(it1.startDay)).toBe("2026-10-12");
    expect(dayKeyOf(it1.endDay)).toBe("2026-10-14");
    const dueOnly = toCalendarItem(mk("b", { dueAt: "2026-10-20T00:00:00Z" }))!;
    expect([dueOnly.allDay, dayKeyOf(dueOnly.startDay), dayKeyOf(dueOnly.endDay)]).toEqual([true, "2026-10-20", "2026-10-20"]);
  });

  it("places timed values at local time and gives a bare 期限 a 30-minute block", () => {
    const start = local(2026, 10, 10, 9, 0);
    const end = local(2026, 10, 10, 10, 30);
    const it1 = toCalendarItem(mk("a", { startAt: start.toISOString(), dueAt: end.toISOString() }))!;
    expect(it1.allDay).toBe(false);
    expect(it1.start!.getTime()).toBe(start.getTime());
    expect(it1.end!.getTime()).toBe(end.getTime());
    // (9:15, not 9:00: a legacy "…T00:00:00Z" value IS 終日 — in JST that is 9:00 — which is
    // why the calendar itself writes timed values with an explicit offset.)
    const bare = toCalendarItem(mk("b", { dueAt: local(2026, 10, 10, 9, 15).toISOString() }))!;
    expect(bare.end!.getTime() - bare.start!.getTime()).toBe(30 * 60_000);
  });

  it("drops archived tasks and returns dateless ones as undated", () => {
    const { items, undated } = toCalendarItems([
      mk("dated", { dueAt: "2026-10-10T00:00:00Z" }),
      mk("none"),
      mk("gone", { dueAt: "2026-10-10T00:00:00Z", archivedAt: "2026-10-01T00:00:00Z" }),
    ]);
    expect(items.map((i) => i.task.id)).toEqual(["dated"]);
    expect(undated.map((t) => t.id)).toEqual(["none"]);
  });
});

describe("layout", () => {
  it("packs overlapping 終日 bars into separate lanes and clips at the range edge", () => {
    const first = day(2026, 10, 4);
    const items = toCalendarItems([
      mk("long", { startAt: "2026-10-02T00:00:00Z", dueAt: "2026-10-06T00:00:00Z" }),
      mk("mid", { startAt: "2026-10-05T00:00:00Z", dueAt: "2026-10-07T00:00:00Z" }),
      mk("late", { dueAt: "2026-10-09T00:00:00Z" }),
    ]).items;
    const spans = layoutSpans(items, first, 7);
    const byId = Object.fromEntries(spans.map((s) => [s.item.task.id, s]));
    expect(byId.long).toMatchObject({ col: 0, span: 3, lane: 0, clipStart: true, clipEnd: false });
    expect(byId.mid).toMatchObject({ col: 1, span: 3, lane: 1 });
    expect(byId.late).toMatchObject({ col: 5, span: 1, lane: 0 });
  });

  it("splits overlapping timed blocks into side-by-side columns", () => {
    const d = day(2026, 10, 10);
    const at = (h: number, m = 0) => local(2026, 10, 10, h, m).toISOString();
    const items = toCalendarItems([
      mk("a", { startAt: at(10), dueAt: at(11) }),
      mk("b", { startAt: at(10, 30), dueAt: at(11, 30) }),
      mk("c", { startAt: at(13), dueAt: at(14) }),
    ]).items;
    const placed = Object.fromEntries(layoutTimedDay(items, d).map((p) => [p.item.task.id, p]));
    expect(placed.a).toMatchObject({ top: 600, height: 60, column: 0, columns: 2 });
    expect(placed.b).toMatchObject({ top: 630, column: 1, columns: 2 });
    expect(placed.c).toMatchObject({ top: 780, column: 0, columns: 1 });
  });

  it("lists a day's items with 終日 first, then by time", () => {
    const d = day(2026, 10, 10);
    const items = toCalendarItems([
      mk("late", { startAt: local(2026, 10, 10, 15).toISOString(), dueAt: local(2026, 10, 10, 16).toISOString() }),
      mk("early", { startAt: local(2026, 10, 10, 8).toISOString(), dueAt: local(2026, 10, 10, 9).toISOString() }),
      mk("allday", { dueAt: "2026-10-10T00:00:00Z" }),
    ]).items;
    expect(itemsOnDay(items, d).map((i) => i.task.id)).toEqual(["allday", "early", "late"]);
  });
});

describe("drafts", () => {
  it("writes 終日 as UTC-midnight dates and timed values with the local offset", () => {
    const d = day(2026, 10, 10);
    expect(draftToDates(draftForAllDay(d, d + 2))).toEqual({
      startAt: "2026-10-10T00:00:00.000Z",
      dueAt: "2026-10-12T00:00:00.000Z",
    });
    const { startAt, dueAt } = draftToDates(draftForSlot(d, 9 * 60, 10 * 60));
    expect(startAt).toMatch(/^2026-10-10T09:00:00(Z|[+-]\d{2}:\d{2})$/);
    expect(Date.parse(startAt)).toBe(local(2026, 10, 10, 9).getTime());
    expect(Date.parse(dueAt)).toBe(local(2026, 10, 10, 10).getTime());
    // A timed value never reads back as 終日, even at 9:00 JST (= 00:00Z).
    expect(toCalendarItem(mk("x", { startAt, dueAt }))!.allDay).toBe(false);
  });

  it("round-trips an item through the edit form", () => {
    const d = day(2026, 10, 10);
    const dates = draftToDates(draftForSlot(d, 13 * 60 + 15, 14 * 60));
    const draft = draftFromItem(toCalendarItem(mk("x", dates))!);
    expect([draft.startDate, draft.startTime, draft.endTime, draft.allDay]).toEqual(["2026-10-10", "13:15", "14:00", false]);
  });

  it("rejects an end before the start", () => {
    const d = day(2026, 10, 10);
    expect(validateDraft(draftForSlot(d, 600, 600))).toBe("終了時刻は開始時刻より後にしてください");
    expect(validateDraft({ ...draftForAllDay(d), endDate: "2026-10-09" })).toBe("終了日は開始日以降にしてください");
    expect(validateDraft(draftForSlot(d, 600, 660))).toBeNull();
  });
});

describe("formatting", () => {
  it("matches Google Calendar's Japanese labels", () => {
    expect(formatHourLabel(9)).toBe("午前9時");
    expect(formatHourLabel(12)).toBe("正午");
    expect(formatHourLabel(15)).toBe("午後3時");
    expect(formatRangeTitle("month", day(2026, 10, 10))).toBe("2026年 10月");
    expect(formatRangeTitle("week", day(2026, 10, 1))).toBe("2026年 9月～10月");
    expect(formatRangeTitle("day", day(2026, 10, 10))).toBe("2026年 10月 10日");
  });
});
