import { describe, expect, it } from "vitest";
import type { meeting } from "@dub/types";
import {
  endTime,
  expandOccurrences,
  formatOccurrence,
  groupOccurrencesByDay,
  jstParts,
  jstToUtcIso,
  recurrenceLabel,
} from "./meeting-occurrences";

function mk(over: Partial<meeting.Meeting>): meeting.Meeting {
  return {
    id: "m1",
    title: "定例",
    description: null,
    targetId: "all",
    targetName: "全体",
    startsAt: "2026-09-07T12:00:00.000Z", // Mon 2026-09-07 21:00 JST
    durationMinutes: 60,
    recurrence: "none",
    until: null,
    meetUrl: null,
    htmlLink: null,
    attendeeCount: 0,
    createdBy: "usr_x" as meeting.Meeting["createdBy"],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    ...over,
  };
}

const days = (m: meeting.Meeting, from: string, to: string) => expandOccurrences(m, from, to).map((o) => o.dateKey);

describe("JST conversion", () => {
  it("round-trips a JST wall clock through UTC", () => {
    expect(jstToUtcIso("2026-10-19", "21:00")).toBe("2026-10-19T12:00:00.000Z");
    expect(jstToUtcIso("2026-10-20", "08:30")).toBe("2026-10-19T23:30:00.000Z");
    expect(jstParts("2026-10-19T23:30:00.000Z")).toEqual({ date: "2026-10-20", time: "08:30", weekday: 2 });
  });

  it("formats an occurrence with weekday and end time", () => {
    expect(formatOccurrence("2026-10-19T12:00:00.000Z", 90)).toBe("2026年10月19日(月) 21:00〜22:30");
    expect(endTime("23:30", 60)).toBe("00:30");
  });
});

describe("recurrenceLabel", () => {
  it("names the weekday / weekday-of-month from the chosen date", () => {
    expect(recurrenceLabel("none", "2026-10-13")).toBe("繰り返さない");
    expect(recurrenceLabel("weekly", "2026-10-13")).toBe("毎週 火曜日");
    expect(recurrenceLabel("biweekly", "2026-10-13")).toBe("隔週 火曜日");
    expect(recurrenceLabel("monthly_weekday", "2026-10-13")).toBe("毎月 第2火曜日");
    expect(recurrenceLabel("monthly_weekday", "2026-09-29")).toBe("毎月 最終火曜日");
  });
});

describe("expandOccurrences", () => {
  it("one-off: only its own day, only when in range", () => {
    expect(days(mk({}), "2026-09-01", "2026-09-30")).toEqual(["2026-09-07"]);
    expect(days(mk({}), "2026-10-01", "2026-10-31")).toEqual([]);
  });

  it("weekly: every 7 days from the first, never before it", () => {
    expect(days(mk({ recurrence: "weekly" }), "2026-08-30", "2026-09-30")).toEqual([
      "2026-09-07",
      "2026-09-14",
      "2026-09-21",
      "2026-09-28",
    ]);
  });

  it("weekly keeps the JST date when the UTC date differs (08:30 JST = previous day UTC)", () => {
    const m = mk({ recurrence: "weekly", startsAt: "2026-10-19T23:30:00.000Z" }); // Tue 10/20 08:30 JST
    const occ = expandOccurrences(m, "2026-10-01", "2026-10-31");
    expect(occ.map((o) => o.dateKey)).toEqual(["2026-10-20", "2026-10-27"]);
    expect(occ[1]!.startsAt).toBe("2026-10-26T23:30:00.000Z");
    expect(occ[1]!.time).toBe("08:30");
  });

  it("biweekly: phase anchored on the first occurrence across a range start", () => {
    expect(days(mk({ recurrence: "biweekly" }), "2026-10-01", "2026-10-31")).toEqual(["2026-10-05", "2026-10-19"]);
  });

  it("respects until (inclusive)", () => {
    expect(days(mk({ recurrence: "weekly", until: "2026-09-21" }), "2026-09-01", "2026-10-31")).toEqual([
      "2026-09-07",
      "2026-09-14",
      "2026-09-21",
    ]);
  });

  it("monthly_weekday: the same N-th weekday each month", () => {
    const m = mk({ recurrence: "monthly_weekday", startsAt: "2026-09-08T12:00:00.000Z" }); // 2nd Tue
    expect(days(m, "2026-09-01", "2026-12-31")).toEqual(["2026-09-08", "2026-10-13", "2026-11-10", "2026-12-08"]);
  });

  it("monthly_weekday with N=5 means the last weekday of every month", () => {
    const m = mk({ recurrence: "monthly_weekday", startsAt: "2026-09-29T12:00:00.000Z" }); // 5th (last) Tue
    expect(days(m, "2026-09-01", "2026-12-31")).toEqual(["2026-09-29", "2026-10-27", "2026-11-24", "2026-12-29"]);
  });

  it("groups by day, sorted by start time", () => {
    const a = mk({ id: "a", title: "B", startsAt: "2026-09-07T12:00:00.000Z" });
    const b = mk({ id: "b", title: "A", startsAt: "2026-09-07T01:00:00.000Z" });
    const byDay = groupOccurrencesByDay([a, b], "2026-09-01", "2026-09-30");
    expect(byDay.get("2026-09-07")!.map((o) => o.meeting.id)).toEqual(["b", "a"]);
  });
});
