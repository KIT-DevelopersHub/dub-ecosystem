// Meeting pure logic (no React, no I/O). Meetings are scheduled in Japan time
// (meeting.MEETING_TIME_ZONE); JST has no DST, so "JST wall clock" = UTC + 9h and a
// recurring meeting keeps the same UTC time-of-day on every occurrence.
//
// Day keys are "YYYY-MM-DD" JST dates, which line up with the grid's day keys
// (calendar-grid.ts builds cells from plain calendar dates).
import type { meeting } from "@dub/types";

const JST_OFFSET_MS = 9 * 3_600_000;
const MS_PER_DAY = 86_400_000;
/** Safety cap on occurrences generated for one meeting in one range. */
const MAX_OCCURRENCES = 400;

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

function dayToKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDaysKey(key: string, days: number): string {
  return dayToKey(new Date(keyToDay(key).getTime() + days * MS_PER_DAY));
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

/** The date of the n-th `weekday` of a month (n>=5 = the last one). month is 0-based. */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): string {
  if (n >= 5) {
    const last = new Date(Date.UTC(year, month + 1, 0));
    const back = (last.getUTCDay() - weekday + 7) % 7;
    return dayToKey(new Date(last.getTime() - back * MS_PER_DAY));
  }
  const first = new Date(Date.UTC(year, month, 1));
  const fwd = (weekday - first.getUTCDay() + 7) % 7;
  return dayToKey(new Date(first.getTime() + (fwd + (n - 1) * 7) * MS_PER_DAY));
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
 */
export function expandOccurrences(m: meeting.Meeting, fromKey: string, toKey: string): MeetingOccurrence[] {
  const first = jstParts(m.startsAt);
  if (!first) return [];
  const firstMs = Date.parse(m.startsAt);
  const recurring = m.recurrence !== "none";
  const lastKey = recurring && m.until && m.until < toKey ? m.until : toKey;
  const out: MeetingOccurrence[] = [];

  const push = (dateKey: string) => {
    if (dateKey < fromKey || dateKey > lastKey || dateKey < first.date) return;
    const offsetDays = Math.round((keyToDay(dateKey).getTime() - keyToDay(first.date).getTime()) / MS_PER_DAY);
    out.push({ meeting: m, dateKey, startsAt: new Date(firstMs + offsetDays * MS_PER_DAY).toISOString(), time: first.time });
  };

  if (m.recurrence === "weekly" || m.recurrence === "biweekly") {
    const step = m.recurrence === "weekly" ? 7 : 14;
    const gap = Math.round((keyToDay(fromKey).getTime() - keyToDay(first.date).getTime()) / MS_PER_DAY);
    let k = gap > 0 ? Math.ceil(gap / step) : 0;
    for (let i = 0; i < MAX_OCCURRENCES; i++, k++) {
      const key = addDaysKey(first.date, k * step);
      if (key > lastKey) break;
      push(key);
    }
  } else if (m.recurrence === "monthly_weekday") {
    const n = weekdayOrdinal(first.date);
    const from = keyToDay(fromKey < first.date ? first.date : fromKey);
    let y = from.getUTCFullYear();
    let mo = from.getUTCMonth();
    for (let i = 0; i < MAX_OCCURRENCES; i++) {
      const key = nthWeekdayOfMonth(y, mo, first.weekday, n);
      if (key.slice(0, 7) > lastKey.slice(0, 7)) break;
      push(key);
      mo += 1;
      if (mo > 11) {
        mo = 0;
        y += 1;
      }
    }
  } else {
    push(first.date);
  }
  return out;
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
