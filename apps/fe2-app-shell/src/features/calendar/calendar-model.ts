// Google Calendar-style model — pure, no React, no I/O. Turns the shared task list
// (@dub/types task.Task) into calendar items and lays them out for the day/week/
// month/schedule views.
//
// Day handling is LOCAL (the viewer's calendar), keyed by an integer "day index"
// (days since 1970-01-01 of the local Y/M/D) so arithmetic never trips over DST.
//
// 終日 vs 時刻指定: マイタスク stores date-only values as UTC midnight
// ("2026-10-10T00:00:00.000Z"), so an item whose dates are all UTC midnight is 終日
// and keeps that calendar date. Anything else is a timed 予定 and is placed at its
// local time. The calendar writes timed values WITH the local offset
// ("2026-10-10T09:00:00+09:00") so 9:00 JST never collides with the 終日 encoding.
import type { task } from "@dub/types";

const MS_PER_DAY = 86_400_000;
const MS_PER_MIN = 60_000;
const ALL_DAY_RE = /T00:00:00(?:\.0+)?Z$/;
/** Shortest drawn block for a timed item (a bare 期限 has no duration). */
export const MIN_TIMED_MINUTES = 30;

export type CalendarView = "day" | "week" | "month" | "schedule";

export interface CalendarItem {
  task: task.Task;
  /** 終日 (date-only) item. */
  allDay: boolean;
  /** First / last local day index the item covers (inclusive). */
  startDay: number;
  endDay: number;
  /** Timed items only: the drawn [start, end) instants. */
  start: Date | null;
  end: Date | null;
}

// ── day index helpers ───────────────────────────────────────────────────────

export function dayIndexOf(d: Date): number {
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / MS_PER_DAY);
}

/** Local midnight for a day index. */
export function dateOfDay(day: number): Date {
  const u = new Date(day * MS_PER_DAY);
  return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate());
}

/** "YYYY-MM-DD" for a day index. */
export function dayKeyOf(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Day index for "YYYY-MM-DD" (or the date part of an ISO string). */
export function dayFromKey(key: string): number {
  const [y, m, d] = key.slice(0, 10).split("-").map(Number);
  return Math.round(Date.UTC(y!, m! - 1, d!) / MS_PER_DAY);
}

/** 0 = Sunday. */
export function weekdayOf(day: number): number {
  return (((day + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
}

export function startOfWeekDay(day: number): number {
  return day - weekdayOf(day);
}

export function startOfMonthDay(day: number): number {
  const d = dateOfDay(day);
  return dayIndexOf(new Date(d.getFullYear(), d.getMonth(), 1));
}

export function addMonthsDay(day: number, delta: number): number {
  const d = dateOfDay(day);
  const target = new Date(d.getFullYear(), d.getMonth() + delta, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return dayIndexOf(new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), lastDay)));
}

/** 6 week rows (42 days) starting on the Sunday on/before the 1st, like Google. */
export function monthGridDays(anchorDay: number): number[] {
  const first = startOfWeekDay(startOfMonthDay(anchorDay));
  return Array.from({ length: 42 }, (_, i) => first + i);
}

/** The visible day range for a view. */
export function visibleDays(view: CalendarView, anchorDay: number): number[] {
  if (view === "day") return [anchorDay];
  if (view === "week") {
    const s = startOfWeekDay(anchorDay);
    return Array.from({ length: 7 }, (_, i) => s + i);
  }
  if (view === "month") return monthGridDays(anchorDay);
  return Array.from({ length: SCHEDULE_DAYS }, (_, i) => anchorDay + i);
}

/** How far ahead the スケジュール view lists. */
export const SCHEDULE_DAYS = 60;

export function shiftAnchor(view: CalendarView, anchorDay: number, dir: 1 | -1): number {
  if (view === "day") return anchorDay + dir;
  if (view === "week") return anchorDay + 7 * dir;
  if (view === "month") return addMonthsDay(anchorDay, dir);
  return anchorDay + SCHEDULE_DAYS * dir;
}

// ── tasks → items ───────────────────────────────────────────────────────────

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t);
}

export function isAllDayValue(iso: string | null | undefined): boolean {
  return !iso || ALL_DAY_RE.test(iso);
}

export function toCalendarItem(t: task.Task): CalendarItem | null {
  const startIso = t.startAt ?? null;
  const dueIso = t.dueAt ?? null;
  const s = parse(startIso);
  const e = parse(dueIso);
  if (!s && !e) return null;

  if (isAllDayValue(startIso) && isAllDayValue(dueIso)) {
    const a = dayFromKey((startIso ?? dueIso)!);
    const b = dayFromKey((dueIso ?? startIso)!);
    return { task: t, allDay: true, startDay: Math.min(a, b), endDay: Math.max(a, b), start: null, end: null };
  }

  const start = (s ?? e)!;
  let end = e ?? s!;
  if (end.getTime() - start.getTime() < MIN_TIMED_MINUTES * MS_PER_MIN) {
    end = new Date(start.getTime() + MIN_TIMED_MINUTES * MS_PER_MIN);
  }
  return {
    task: t,
    allDay: false,
    startDay: dayIndexOf(start),
    endDay: dayIndexOf(new Date(end.getTime() - 1)),
    start,
    end,
  };
}

export function toCalendarItems(tasks: readonly task.Task[]): { items: CalendarItem[]; undated: task.Task[] } {
  const items: CalendarItem[] = [];
  const undated: task.Task[] = [];
  for (const t of tasks) {
    if (t.archivedAt) continue;
    const it = toCalendarItem(t);
    if (it) items.push(it);
    else undated.push(t);
  }
  return { items, undated };
}

/** Items drawn in the 終日 lane: 終日 items plus timed items crossing midnight. */
export function isBannerItem(it: CalendarItem): boolean {
  return it.allDay || it.startDay !== it.endDay;
}

// ── 終日 lane layout (bars spanning columns) ─────────────────────────────────

export interface SpanPlacement {
  item: CalendarItem;
  /** 0-based column within the range. */
  col: number;
  span: number;
  lane: number;
  /** The bar continues past the left / right edge of the range. */
  clipStart: boolean;
  clipEnd: boolean;
}

function compareItems(a: CalendarItem, b: CalendarItem): number {
  if (a.startDay !== b.startDay) return a.startDay - b.startDay;
  const len = b.endDay - b.startDay - (a.endDay - a.startDay);
  if (len !== 0) return len;
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  const at = a.start?.getTime() ?? 0;
  const bt = b.start?.getTime() ?? 0;
  if (at !== bt) return at - bt;
  return a.task.title.localeCompare(b.task.title, "ja");
}

/** Greedy lane packing of banner items over [firstDay, firstDay+numDays). */
export function layoutSpans(items: readonly CalendarItem[], firstDay: number, numDays: number): SpanPlacement[] {
  const lastDay = firstDay + numDays - 1;
  const laneEnds: number[] = [];
  const out: SpanPlacement[] = [];
  const visible = items.filter((it) => it.endDay >= firstDay && it.startDay <= lastDay).sort(compareItems);
  for (const item of visible) {
    const from = Math.max(item.startDay, firstDay);
    const to = Math.min(item.endDay, lastDay);
    let lane = laneEnds.findIndex((end) => end < from);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(to);
    } else {
      laneEnds[lane] = to;
    }
    out.push({
      item,
      col: from - firstDay,
      span: to - from + 1,
      lane,
      clipStart: item.startDay < firstDay,
      clipEnd: item.endDay > lastDay,
    });
  }
  return out;
}

// ── timed layout within one day column ──────────────────────────────────────

export interface TimedPlacement {
  item: CalendarItem;
  /** Minutes from local midnight. */
  top: number;
  height: number;
  /** Column within its overlap cluster, and the cluster's column count. */
  column: number;
  columns: number;
}

/** Minutes since local midnight of `day`, clamped to the day. */
function minutesInDay(d: Date, day: number): number {
  const m = Math.round((d.getTime() - dateOfDay(day).getTime()) / MS_PER_MIN);
  return Math.max(0, Math.min(24 * 60, m));
}

export function layoutTimedDay(items: readonly CalendarItem[], day: number): TimedPlacement[] {
  const dayItems = items
    .filter((it) => !isBannerItem(it) && it.startDay === day)
    .map((item) => {
      const top = minutesInDay(item.start!, day);
      const bottom = Math.max(top + MIN_TIMED_MINUTES, minutesInDay(item.end!, day));
      return { item, top, height: bottom - top, column: 0, columns: 1 };
    })
    .sort((a, b) => a.top - b.top || b.height - a.height);

  // Cluster transitively-overlapping blocks, then pack each cluster into columns.
  let cluster: TimedPlacement[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const colEnds: number[] = [];
    for (const p of cluster) {
      let c = colEnds.findIndex((end) => end <= p.top);
      if (c < 0) {
        c = colEnds.length;
        colEnds.push(0);
      }
      colEnds[c] = p.top + p.height;
      p.column = c;
    }
    for (const p of cluster) p.columns = colEnds.length;
    cluster = [];
  };
  for (const p of dayItems) {
    if (cluster.length > 0 && p.top >= clusterEnd) flush();
    cluster.push(p);
    clusterEnd = Math.max(clusterEnd, p.top + p.height);
  }
  flush();
  return dayItems;
}

/** Timed (non-banner) items on a day, by start time — month cells / schedule rows. */
export function timedItemsOn(items: readonly CalendarItem[], day: number): CalendarItem[] {
  return items
    .filter((it) => !isBannerItem(it) && it.startDay === day)
    .sort((a, b) => a.start!.getTime() - b.start!.getTime() || a.task.title.localeCompare(b.task.title, "ja"));
}

/** Every item touching `day` (banners first), for the スケジュール list and "他N件". */
export function itemsOnDay(items: readonly CalendarItem[], day: number): CalendarItem[] {
  const banners = items.filter((it) => isBannerItem(it) && it.startDay <= day && it.endDay >= day).sort(compareItems);
  return [...banners, ...timedItemsOn(items, day)];
}

// ── formatting (Japanese Google Calendar style) ─────────────────────────────

export const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"] as const;

const pad2 = (n: number) => String(n).padStart(2, "0");

export function formatTime(d: Date): string {
  return `${d.getHours()}:${pad2(d.getMinutes())}`;
}

/** Gutter label: 午前1時 … 正午 … 午後11時. */
export function formatHourLabel(h: number): string {
  if (h === 12) return "正午";
  return h < 12 ? `午前${h}時` : `午後${h - 12}時`;
}

/** "10月10日（土曜日）" */
export function formatDayLong(day: number): string {
  const d = dateOfDay(day);
  return `${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS_JA[d.getDay()]}曜日）`;
}

/** Toolbar title: "2026年 10月" / "2026年 9月～10月" / "2026年 10月 10日". */
export function formatRangeTitle(view: CalendarView, anchorDay: number): string {
  const a = dateOfDay(anchorDay);
  if (view === "day") return `${a.getFullYear()}年 ${a.getMonth() + 1}月 ${a.getDate()}日`;
  if (view === "month") return `${a.getFullYear()}年 ${a.getMonth() + 1}月`;
  const days = visibleDays(view, anchorDay);
  const s = dateOfDay(days[0]!);
  const e = dateOfDay(days[days.length - 1]!);
  if (s.getFullYear() !== e.getFullYear()) {
    return `${s.getFullYear()}年 ${s.getMonth() + 1}月～${e.getFullYear()}年 ${e.getMonth() + 1}月`;
  }
  if (s.getMonth() !== e.getMonth()) return `${s.getFullYear()}年 ${s.getMonth() + 1}月～${e.getMonth() + 1}月`;
  return `${s.getFullYear()}年 ${s.getMonth() + 1}月`;
}

/** Detail/schedule line: "10月10日（土曜日）⋅ 10:00～11:00" or a 終日 range. */
export function formatItemWhen(it: CalendarItem): string {
  if (it.allDay) {
    return it.startDay === it.endDay
      ? formatDayLong(it.startDay)
      : `${formatDayLong(it.startDay)}～${formatDayLong(it.endDay)}`;
  }
  if (it.startDay === it.endDay) {
    return `${formatDayLong(it.startDay)}⋅${formatTime(it.start!)}～${formatTime(it.end!)}`;
  }
  return `${formatDayLong(it.startDay)} ${formatTime(it.start!)}～${formatDayLong(it.endDay)} ${formatTime(it.end!)}`;
}

// ── draft (create / edit form) ──────────────────────────────────────────────

export interface EventDraft {
  title: string;
  description: string;
  allDay: boolean;
  /** "YYYY-MM-DD" */
  startDate: string;
  endDate: string;
  /** "HH:MM" (ignored when allDay) */
  startTime: string;
  endTime: string;
}

export function minutesToHHMM(m: number): string {
  const c = Math.max(0, Math.min(24 * 60 - 1, m));
  return `${pad2(Math.floor(c / 60))}:${pad2(c % 60)}`;
}

export function hhmmToMinutes(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** "+09:00" style offset of the local zone at a given local date/time. */
function offsetFor(date: Date): string {
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

function localIso(dateKey: string, hhmm: string): string {
  const [y, mo, d] = dateKey.split("-").map(Number);
  const mins = hhmmToMinutes(hhmm);
  const local = new Date(y!, mo! - 1, d!, Math.floor(mins / 60), mins % 60);
  return `${dateKey}T${hhmm}:00${offsetFor(local)}`;
}

export function draftForSlot(day: number, startMin: number, endMin: number): EventDraft {
  const key = dayKeyOf(day);
  return {
    title: "",
    description: "",
    allDay: false,
    startDate: key,
    endDate: key,
    startTime: minutesToHHMM(startMin),
    endTime: minutesToHHMM(Math.min(endMin, 24 * 60 - 1)),
  };
}

export function draftForAllDay(startDay: number, endDay: number = startDay): EventDraft {
  return {
    title: "",
    description: "",
    allDay: true,
    startDate: dayKeyOf(startDay),
    endDate: dayKeyOf(endDay),
    startTime: "09:00",
    endTime: "10:00",
  };
}

export function draftFromItem(it: CalendarItem): EventDraft {
  if (it.allDay) {
    return {
      ...draftForAllDay(it.startDay, it.endDay),
      title: it.task.title,
      description: it.task.description ?? "",
    };
  }
  return {
    title: it.task.title,
    description: it.task.description ?? "",
    allDay: false,
    startDate: dayKeyOf(it.startDay),
    endDate: dayKeyOf(it.endDay),
    startTime: formatHHMM(it.start!),
    endTime: formatHHMM(it.end!),
  };
}

function formatHHMM(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Validation message, or null when the draft can be saved. */
export function validateDraft(d: EventDraft): string | null {
  if (!d.startDate || !d.endDate) return "日付を入力してください";
  if (d.endDate < d.startDate) return "終了日は開始日以降にしてください";
  if (!d.allDay && d.endDate === d.startDate && hhmmToMinutes(d.endTime) <= hhmmToMinutes(d.startTime)) {
    return "終了時刻は開始時刻より後にしてください";
  }
  return null;
}

/** The task-service date pair for a draft. */
export function draftToDates(d: EventDraft): { startAt: string; dueAt: string } {
  if (d.allDay) {
    return { startAt: `${d.startDate}T00:00:00.000Z`, dueAt: `${d.endDate}T00:00:00.000Z` };
  }
  return { startAt: localIso(d.startDate, d.startTime), dueAt: localIso(d.endDate, d.endTime) };
}

/** Every 15 minutes, for the time pickers. */
export const TIME_OPTIONS: string[] = Array.from({ length: 96 }, (_, i) => minutesToHHMM(i * 15));
