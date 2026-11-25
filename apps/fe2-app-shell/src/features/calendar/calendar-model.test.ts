// Pure model tests. Written timezone-agnostic: expectations are built with the local
// Date constructor, so they hold in JST locally and UTC in CI alike.
import { describe, expect, it } from "vitest";
import type { common, task } from "@dub/types";
import {
  datesAfterDrag,
  dragPatch,
  dayFromKey,
  dayIndexOf,
  dayKeyOf,
  draftForAllDay,
  draftForSlot,
  draftFromItem,
  encodeDescription,
  isScheduleTask,
  isVacationTask,
  kindOf,
  labelOf,
  userDescription,
  withKind,
  draftToDates,
  formatHourLabel,
  formatRangeTitle,
  itemsOnDay,
  layoutSpans,
  layoutTimedDay,
  monthGridDays,
  sameDates,
  shiftAnchor,
  toCalendarItem,
  toCalendarItems,
  validateDraft,
  visibleDays,
  weekdayOf,
  type CalendarItem,
  type ItemDrag,
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

describe("休暇", () => {
  it("round-trips the tag through the draft without exposing it", () => {
    const t = mk("v", { startAt: "2026-10-12T00:00:00.000Z", dueAt: "2026-10-13T00:00:00.000Z" });
    const tagged = { ...t, description: "#休暇\n連絡はチャットへ" };
    expect(isVacationTask(tagged)).toBe(true);
    expect(userDescription(tagged)).toBe("連絡はチャットへ");
    const d = draftFromItem(toCalendarItem(tagged)!);
    expect(d).toMatchObject({ kind: "vacation", description: "連絡はチャットへ", allDay: true });
    expect(encodeDescription(d)).toBe("#休暇\n連絡はチャットへ");
    expect(encodeDescription({ ...d, description: "" })).toBe("#休暇");
    expect(isVacationTask({ description: "#休暇の相談" })).toBe(false);
    expect(isVacationTask({ description: null })).toBe(false);
  });

  it("switching to 休暇 makes the draft 終日", () => {
    const d = withKind(draftForSlot(dayFromKey("2026-10-10"), 9 * 60, 10 * 60), "vacation");
    expect(d).toMatchObject({ kind: "vacation", allDay: true, startDate: "2026-10-10" });
    expect(withKind(d, "event")).toMatchObject({ kind: "event", allDay: true });
  });

  it("ラベル rides as a tag line alongside 休暇 and defaults to 個人", () => {
    expect(labelOf({ description: null })).toBe("personal");
    expect(labelOf({ description: "#ラベル:role_lead\nメモ" })).toBe("role_lead");
    const both = { description: "#休暇\n#ラベル:role_lead\n連絡はチャットへ" };
    expect(isVacationTask(both)).toBe(true);
    expect(labelOf(both)).toBe("role_lead");
    expect(userDescription(both)).toBe("連絡はチャットへ");
    expect(encodeDescription({ kind: "vacation", label: "role_lead", description: "連絡はチャットへ" })).toBe(both.description);
    expect(encodeDescription({ kind: "event", label: "role_lead", description: "" })).toBe("#予定\n#ラベル:role_lead");
    expect(encodeDescription({ kind: "event", label: "personal", description: "  " })).toBe("#予定");
    // Plain descriptions are untouched (no tag parsing past the first non-tag line).
    expect(userDescription({ description: "メモ\n#ラベル:role_lead" })).toBe("メモ\n#ラベル:role_lead");
  });
});

describe("予定 vs タスク", () => {
  const at = (description: string | null, startAt: string | null, dueAt: string | null, eventId: string | null = null) =>
    ({ description, startAt, dueAt, eventId: eventId as common.EventId | null });
  it("a kind or ラベル tag makes a 予定, whatever its dates", () => {
    expect(isScheduleTask(at("#ミーティング", null, "2026-10-10T00:00:00.000Z"))).toBe(true);
    expect(kindOf({ description: "#ミーティング\n#ラベル:role_lead" })).toBe("meeting");
    expect(kindOf({ description: "#予行練習" })).toBe("rehearsal");
    expect(isScheduleTask(at("#ラベル:role_lead", null, "2026-10-10T00:00:00.000Z"))).toBe(true);
  });
  it("an untagged timed item is a 予定 saved before kinds; date-only is a タスク", () => {
    expect(isScheduleTask(at(null, "2026-10-10T09:00:00+09:00", "2026-10-10T10:00:00+09:00"))).toBe(true);
    expect(kindOf({ description: null })).toBe("event");
    expect(isScheduleTask(at(null, null, "2026-10-10T00:00:00.000Z"))).toBe(false);
    expect(isScheduleTask(at("メモ", "2026-10-09T00:00:00.000Z", "2026-10-10T00:00:00.000Z"))).toBe(false);
    // An event task with a time is still a タスク.
    expect(isScheduleTask(at(null, null, "2026-10-10T09:00:00Z", "evt_1"))).toBe(false);
  });
});

describe("datesAfterDrag", () => {
  const day = dayFromKey("2026-11-04");
  const task = (startAt: string, dueAt: string, id = "t1") => ({ id, title: "x", description: "#予定", startAt, dueAt }) as unknown as task.Task;
  const itemOf = (t: task.Task) => toCalendarItem(t)!;
  /** Timed values as the calendar writes them (local offset), so this holds in any TZ. */
  const slot = (startMin: number, endMin: number, id?: string) => {
    const d = draftToDates(draftForSlot(day, startMin, endMin));
    return itemOf(task(d.startAt, d.dueAt, id));
  };
  const timed = slot(10 * 60, 11 * 60);
  const move = (item: CalendarItem, fromDay = item.startDay, grabMinute = 0): ItemDrag => ({ item, mode: "move", fromDay, grabMinute });
  const resize = (item: CalendarItem): ItemDrag => ({ item, mode: "resize", fromDay: item.startDay, grabMinute: 0 });
  const hhmm = (iso: string | null | undefined) => iso!.slice(11, 16);

  it("moves a timed item across days on the 15-minute grid, keeping the grab point and duration", () => {
    const got = datesAfterDrag(move(timed, day, 20), { kind: "timed", day: day + 2, minute: 14 * 60 + 27 })!;
    expect(got.startAt!.slice(0, 16)).toBe("2026-11-06T14:00");
    expect(got.dueAt!.slice(0, 16)).toBe("2026-11-06T15:00");
  });

  it("never writes a timed value that reads as 終日", () => {
    const got = datesAfterDrag(move(timed), { kind: "timed", day, minute: 9 * 60 })!;
    expect(toCalendarItem({ ...timed.task, ...got })!.allDay).toBe(false);
  });

  it("keeps a short item's stored duration, not the padded drawn one", () => {
    const short = slot(10 * 60, 10 * 60 + 15);
    const got = datesAfterDrag(move(short), { kind: "timed", day, minute: 12 * 60 })!;
    expect([hhmm(got.startAt), hhmm(got.dueAt)]).toEqual(["12:00", "12:15"]);
  });

  it("stops at the end of the day instead of spilling into the next", () => {
    const got = datesAfterDrag(move(timed), { kind: "timed", day, minute: 23 * 60 + 50 })!;
    expect([hhmm(got.startAt), got.dueAt!.slice(0, 16)]).toEqual(["23:00", "2026-11-05T00:00"]);
    expect(toCalendarItem({ ...timed.task, ...got })!.endDay).toBe(day);
  });

  it("月: keeps the time of day and shifts the date", () => {
    const got = datesAfterDrag(move(timed), { kind: "day", day: day + 3 })!;
    expect(got.startAt!.slice(0, 16)).toBe("2026-11-07T10:00");
  });

  it("converts between 終日 and timed like Google", () => {
    const toAllDay = datesAfterDrag(move(timed), { kind: "allday", day: day + 1 })!;
    expect(toAllDay).toEqual({ startAt: "2026-11-05T00:00:00.000Z", dueAt: "2026-11-05T00:00:00.000Z" });
    const allDay = itemOf(task("2026-11-04T00:00:00.000Z", "2026-11-05T00:00:00.000Z"));
    const toTimed = datesAfterDrag(move(allDay), { kind: "timed", day, minute: 9 * 60 })!;
    expect([hhmm(toTimed.startAt), hhmm(toTimed.dueAt)]).toEqual(["09:00", "10:00"]);
  });

  it("moves a multi-day 終日 item by the days the pointer moved from its grab day", () => {
    const allDay = itemOf(task("2026-11-04T00:00:00.000Z", "2026-11-06T00:00:00.000Z"));
    expect(datesAfterDrag(move(allDay, allDay.startDay + 1), { kind: "day", day: allDay.startDay + 3 })).toEqual({
      startAt: "2026-11-06T00:00:00.000Z",
      dueAt: "2026-11-08T00:00:00.000Z",
    });
  });

  it("a meeting cannot become 終日", () => {
    const meet = slot(10 * 60, 11 * 60, "meet:m1:2026-11-04");
    expect(datesAfterDrag(move(meet), { kind: "allday", day })).toBeNull();
  });

  it("a 終日 item dropped at the very bottom stays on that day", () => {
    const allDay = itemOf(task("2026-11-04T00:00:00.000Z", "2026-11-04T00:00:00.000Z"));
    const got = datesAfterDrag(move(allDay), { kind: "timed", day, minute: 23 * 60 + 50 })!;
    expect(toCalendarItem({ ...allDay.task, ...got })).toMatchObject({ allDay: false, startDay: day, endDay: day });
  });

  it("a meeting cannot be stretched past what the server accepts", () => {
    const meet = slot(9 * 60, 10 * 60, "meet:m1:2026-11-04");
    expect(hhmm(datesAfterDrag(resize(meet), { kind: "timed", day, minute: 23 * 60 })!.dueAt)).toBe("21:00");
  });

  it("a 予定 saved before kinds existed keeps being a 予定 when made 終日", () => {
    const d = draftToDates(draftForSlot(day, 600, 660));
    const legacy = itemOf({ ...task(d.startAt, d.dueAt), description: "メモ" } as task.Task);
    const dates = datesAfterDrag(move(legacy), { kind: "allday", day })!;
    const patch = dragPatch(legacy, dates);
    expect(patch.description).toBe("#予定\nメモ");
    expect(isScheduleTask({ ...legacy.task, ...patch })).toBe(true);
    expect(dragPatch(timed, datesAfterDrag(move(timed), { kind: "allday", day })!).description).toBeUndefined();
  });

  it("resizes a timed item's end, never below the shortest block or past 24:00", () => {
    expect(hhmm(datesAfterDrag(resize(timed), { kind: "timed", day, minute: 12 * 60 + 8 })!.dueAt)).toBe("12:15");
    expect(hhmm(datesAfterDrag(resize(timed), { kind: "timed", day, minute: 60 })!.dueAt)).toBe("10:30");
    expect(datesAfterDrag(resize(timed), { kind: "timed", day, minute: 24 * 60 + 60 })!.dueAt!.slice(0, 16)).toBe("2026-11-05T00:00");
  });

  it("resizes a 終日 item's last day, never before its first", () => {
    const allDay = itemOf(task("2026-11-04T00:00:00.000Z", "2026-11-04T00:00:00.000Z"));
    expect(datesAfterDrag(resize(allDay), { kind: "day", day: allDay.startDay + 2 })!.dueAt).toBe("2026-11-06T00:00:00.000Z");
    expect(datesAfterDrag(resize(allDay), { kind: "day", day: allDay.startDay - 2 })!.dueAt).toBe("2026-11-04T00:00:00.000Z");
  });

  it("an item ending at 24:00 opens in the edit form as a valid range", () => {
    const got = datesAfterDrag(resize(timed), { kind: "timed", day, minute: 24 * 60 })!;
    expect(validateDraft(draftFromItem(toCalendarItem({ ...timed.task, ...got })!))).toBeNull();
  });

  it("sameDates compares instants, not spellings", () => {
    const { startAt, dueAt } = timed.task;
    expect(sameDates(timed.task, { startAt: new Date(startAt!).toISOString(), dueAt })).toBe(true);
    expect(sameDates(timed.task, { startAt, dueAt: new Date(Date.parse(dueAt!) + 60_000).toISOString() })).toBe(false);
  });
});
