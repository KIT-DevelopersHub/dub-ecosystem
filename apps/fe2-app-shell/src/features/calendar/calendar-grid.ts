// Calendar pure logic — no React, no I/O, fully unit-testable. Turns the shared
// task list (@dub/types task.Task — the SAME source the マイタスク list and the
// ガントチャート read) into month/week grid cells keyed by calendar day.
//
// Date handling is UTC-based on purpose: task dates are stored as ISO instants
// (e.g. "2026-08-03T09:00:00Z") and the grid is built from UTC day numbers, so
// day-bucketing is deterministic across machines/timezones (and in CI/jsdom).
import type { task } from "@dub/types";

export type CalendarViewMode = "month" | "week";

/** One calendar cell (a single day). */
export interface DayCell {
  /** UTC calendar date at 00:00. */
  date: Date;
  /** "YYYY-MM-DD" day key (UTC). */
  key: string;
  /** Day-of-month number (1–31). */
  day: number;
  /** True when the cell belongs to the focused month (false = leading/trailing spill). */
  inMonth: boolean;
  /** True when the cell is today (UTC). */
  isToday: boolean;
  /** True for Sat/Sun (0=Sun, 6=Sat). */
  isWeekend: boolean;
}

/** A task placed on a calendar day, tagged with its position in a multi-day span. */
export interface DayTask {
  task: task.Task;
  /** True on the first day the bar appears (renders the title). */
  isStart: boolean;
  /** True on the last day (its 期限/deadline day). */
  isEnd: boolean;
  /** True when the task spans more than one day. */
  isSpan: boolean;
}

export const WEEKDAY_LABELS_JA = ["日", "月", "火", "水", "木", "金", "土"] as const;
const MS_PER_DAY = 86_400_000;

/** "YYYY-MM-DD" UTC day key for a Date. */
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Parse an ISO instant to its UTC day (00:00), or null when absent/invalid. */
export function isoToUtcDay(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** UTC midnight for a given y/m/d. `month` is 0-based. */
function utcDay(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day));
}

/** First day of the focused month (UTC). */
export function startOfMonth(anchor: Date): Date {
  return utcDay(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1);
}

/** Shift by whole months, preserving the 1st-of-month anchor. */
export function addMonths(anchor: Date, delta: number): Date {
  return utcDay(anchor.getUTCFullYear(), anchor.getUTCMonth() + delta, 1);
}

/** Shift by whole days. */
export function addDays(anchor: Date, delta: number): Date {
  return new Date(anchor.getTime() + delta * MS_PER_DAY);
}

/** The Sunday on/just before `anchor` (week starts Sunday, JA convention). */
export function startOfWeek(anchor: Date): Date {
  const d = utcDay(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
  return addDays(d, -d.getUTCDay());
}

/** "2026年8月" style month label. */
export function formatMonthLabel(anchor: Date): string {
  return `${anchor.getUTCFullYear()}年${anchor.getUTCMonth() + 1}月`;
}

function toCell(date: Date, focusMonth: number, todayKey: string): DayCell {
  const dow = date.getUTCDay();
  return {
    date,
    key: dayKey(date),
    day: date.getUTCDate(),
    inMonth: date.getUTCMonth() === focusMonth,
    isToday: dayKey(date) === todayKey,
    isWeekend: dow === 0 || dow === 6,
  };
}

/**
 * Build a fixed 6×7 (42-cell) month grid so the layout never jumps height as
 * months change. Leading days come from the previous month, trailing from the
 * next; `inMonth` flags the focused month's own days.
 */
export function buildMonthGrid(anchor: Date, today: Date = new Date()): DayCell[] {
  const first = startOfMonth(anchor);
  const gridStart = addDays(first, -first.getUTCDay());
  const focusMonth = first.getUTCMonth();
  const todayKey = dayKey(today);
  return Array.from({ length: 42 }, (_, i) => toCell(addDays(gridStart, i), focusMonth, todayKey));
}

/** Build a single 7-cell week row containing `anchor`. */
export function buildWeekGrid(anchor: Date, today: Date = new Date()): DayCell[] {
  const start = startOfWeek(anchor);
  const focusMonth = anchor.getUTCMonth();
  const todayKey = dayKey(today);
  return Array.from({ length: 7 }, (_, i) => toCell(addDays(start, i), focusMonth, todayKey));
}

/**
 * Group tasks onto calendar days. A task with both `startAt` and `dueAt` occupies
 * every day in [startAt, dueAt] (a span); a task with only `dueAt` sits on that one
 * deadline day; a task with only `startAt` sits on its start day. Tasks with no
 * date at all are returned separately (never lost).
 *
 * Returned map values are sorted for stable rendering: spans first (longer spans
 * first), then by title.
 */
export function groupTasksByDay(tasks: readonly task.Task[]): {
  byDay: Map<string, DayTask[]>;
  undated: task.Task[];
} {
  const byDay = new Map<string, DayTask[]>();
  const undated: task.Task[] = [];

  const push = (key: string, dt: DayTask) => {
    const list = byDay.get(key);
    if (list) list.push(dt);
    else byDay.set(key, [dt]);
  };

  for (const t of tasks) {
    if (t.archivedAt) continue; // archived tasks stay off the calendar
    const start = isoToUtcDay(t.startAt);
    const due = isoToUtcDay(t.dueAt);

    if (start && due && due.getTime() > start.getTime()) {
      const endKey = dayKey(due);
      for (let d = start; d.getTime() <= due.getTime(); d = addDays(d, 1)) {
        const k = dayKey(d);
        push(k, { task: t, isStart: k === dayKey(start), isEnd: k === endKey, isSpan: true });
      }
      continue;
    }
    const single = due ?? start;
    if (single) {
      push(dayKey(single), { task: t, isStart: true, isEnd: true, isSpan: false });
      continue;
    }
    undated.push(t);
  }

  for (const list of byDay.values()) {
    list.sort((a, b) => {
      const spanDiff = Number(b.isSpan) - Number(a.isSpan);
      if (spanDiff !== 0) return spanDiff;
      return a.task.title.localeCompare(b.task.title, "ja");
    });
  }
  return { byDay, undated };
}
