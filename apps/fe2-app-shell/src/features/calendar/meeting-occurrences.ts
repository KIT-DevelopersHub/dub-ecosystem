// Meeting pure logic (no React, no I/O). Meetings are scheduled in Japan time
// (meeting.MEETING_TIME_ZONE); JST has no DST, so "JST wall clock" = UTC + 9h and a
// recurring meeting keeps the same UTC time-of-day on every occurrence.
//
// Day keys are "YYYY-MM-DD" JST dates, which line up with the grid's day keys
// (calendar-grid.ts builds cells from plain calendar dates).
import type { common, meeting, task } from "@dub/types";
import { meeting as meetingRules } from "@dub/types";
import { MEETING_ITEM_PREFIX } from "./calendar-model";

const JST_OFFSET_MS = 9 * 3_600_000;

export const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"] as const;

export interface JstParts {
  /** "YYYY-MM-DD" (JST). */
  date: string;
  /** "HH:MM" (JST). */
  time: string;
  /** 0=Sun … 6=Sat (JST). */
  weekday: number;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** A UTC-midnight Date for a "YYYY-MM-DD" key (calendar arithmetic only). */
function keyToDay(key: string): Date {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

/** JST date / time / weekday of a UTC ISO instant (null when invalid). */
export function jstParts(iso: string): JstParts | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t + JST_OFFSET_MS);
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    weekday: d.getUTCDay(),
  };
}

/** JST "YYYY-MM-DD" + "HH:MM" → UTC ISO instant. */
export function jstToUtcIso(date: string, time: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - JST_OFFSET_MS).toISOString();
}

/** Weekday (0=Sun) of a "YYYY-MM-DD" date. */
export function weekdayOf(date: string): number {
  return keyToDay(date).getUTCDay();
}

/** Which weekday-of-month the date is (1–5; 5 = the 5th, which the server treats as "last"). */
export function weekdayOrdinal(date: string): number {
  return Math.ceil(keyToDay(date).getUTCDate() / 7);
}

/** "第2火曜日" / "最終火曜日" for a date. */
export function monthlyWeekdayLabel(date: string): string {
  const n = weekdayOrdinal(date);
  const wd = `${WEEKDAY_JA[weekdayOf(date)]}曜日`;
  return n >= 5 ? `最終${wd}` : `第${n}${wd}`;
}

/** Human label for a recurrence anchored on a JST date, e.g. 「毎月 第2火曜日」. */
export function recurrenceLabel(recurrence: meeting.MeetingRecurrence, date: string): string {
  const wd = `${WEEKDAY_JA[weekdayOf(date)]}曜日`;
  switch (recurrence) {
    case "weekly":
      return `毎週 ${wd}`;
    case "biweekly":
      return `隔週 ${wd}`;
    case "monthly_weekday":
      return `毎月 ${monthlyWeekdayLabel(date)}`;
    default:
      return "繰り返さない";
  }
}

export interface MeetingOccurrence {
  meeting: meeting.Meeting;
  /** JST day key the occurrence falls on. */
  dateKey: string;
  /** Occurrence start (UTC ISO). */
  startsAt: string;
  /** "HH:MM" JST start time. */
  time: string;
}

/**
 * Every occurrence of `m` whose JST date is within [fromKey, toKey] (inclusive),
 * honouring `until` (inclusive JST date). Occurrences never precede the first one.
 * The recurrence rule itself is the shared one (@dub/types meeting.occurrenceStarts).
 */
export function expandOccurrences(m: meeting.Meeting, fromKey: string, toKey: string): MeetingOccurrence[] {
  const first = jstParts(m.startsAt);
  if (!first) return [];
  return meetingRules.occurrenceStarts(m, fromKey, toKey).map((o) => ({ meeting: m, dateKey: o.date, startsAt: o.startsAt, time: first.time }));
}

/** Occurrences of many meetings grouped by JST day key, each day sorted by start time. */
export function groupOccurrencesByDay(
  meetings: readonly meeting.Meeting[],
  fromKey: string,
  toKey: string,
): Map<string, MeetingOccurrence[]> {
  const byDay = new Map<string, MeetingOccurrence[]>();
  for (const m of meetings) {
    for (const occ of expandOccurrences(m, fromKey, toKey)) {
      const list = byDay.get(occ.dateKey);
      if (list) list.push(occ);
      else byDay.set(occ.dateKey, [occ]);
    }
  }
  for (const list of byDay.values()) list.sort((a, b) => a.time.localeCompare(b.time) || a.meeting.title.localeCompare(b.meeting.title, "ja"));
  return byDay;
}

/** "HH:MM" end time for a start time + duration (wraps past midnight). */
export function endTime(time: string, durationMinutes: number): string {
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  const total = (hh * 60 + mm + durationMinutes) % (24 * 60);
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** 「2026年10月19日(月) 21:00〜22:00」 for one occurrence. */
export function formatOccurrence(startsAt: string, durationMinutes: number): string {
  const p = jstParts(startsAt);
  if (!p) return "—";
  const [y, m, d] = p.date.split("-").map(Number) as [number, number, number];
  return `${y}年${m}月${d}日(${WEEKDAY_JA[p.weekday]}) ${p.time}〜${endTime(p.time, durationMinutes)}`;
}

/**
 * Occurrences in [fromKey, toKey] as synthetic tasks the calendar views can draw
 * (timed, id = MEETING_ITEM_PREFIX + meeting id + day), plus a lookup back to the occurrence.
 */
export function meetingTasks(
  meetings: readonly meeting.Meeting[],
  fromKey: string,
  toKey: string,
): { tasks: task.Task[]; byId: Map<string, MeetingOccurrence> } {
  const tasks: task.Task[] = [];
  const byId = new Map<string, MeetingOccurrence>();
  for (const m of meetings) {
    for (const occ of expandOccurrences(m, fromKey, toKey)) {
      const id = `${MEETING_ITEM_PREFIX}${m.id}:${occ.dateKey}`;
      byId.set(id, occ);
      tasks.push({
        id: id as common.TaskId,
        version: 0,
        title: m.title,
        description: null,
        status: "todo",
        priority: "medium",
        assigneeId: null,
        origin: "internal",
        startAt: occ.startsAt,
        dueAt: new Date(Date.parse(occ.startsAt) + m.durationMinutes * 60_000).toISOString(),
        archivedAt: null,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      });
    }
  }
  return { tasks, byId };
}
