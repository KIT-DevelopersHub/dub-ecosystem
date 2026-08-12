// Infinite (endless) timeline axis for the Notion-style timeline view.
//
// The old gantt-layout clamped the canvas to [min..max] of the dated rows, so
// the chart visibly "ended" at the last task (the 9/2 problem). This module
// instead anchors x=0 at a fixed origin in the past and lets the window END grow
// on demand (the caller extends `endMs` when the user scrolls near the right
// edge), so the axis never terminates. All geometry is pure + unit-testable; the
// component owns scrolling/DOM. No chart lib — self-drawn.
import type { gantt } from "@dub/types";

export const MS_PER_DAY = 86_400_000;
export const ROW_HEIGHT = 44;
export const BAR_HEIGHT = 26;

export type Granularity = gantt.GanttZoom; // "day" | "week" | "month"

/** Pixels per day per granularity. Tuned so a week/month reads as a tidy column:
 *  day≈34px/day, week≈105px/week, month≈156px/month. */
export const PX_PER_DAY: Record<Granularity, number> = {
  day: 34,
  week: 15,
  month: 5.2,
};

/** Buffer (days) padded before the earliest anchor and after the latest anchor
 *  when the window is first built. The end then grows further on scroll. */
const PAST_BUFFER_DAYS = 60;
const FUTURE_BUFFER_DAYS = 150;
/** Days appended each time the caller extends the endless right edge. */
export const EXTEND_STEP_DAYS = 180;

export function floorDayUtc(ms: number): number {
  return Math.floor(ms / MS_PER_DAY) * MS_PER_DAY;
}

export interface AxisWindow {
  /** Day-floored ms mapped to x=0. Fixed for the lifetime of the view. */
  originMs: number;
  /** Day-floored exclusive right edge. Grows via `extendWindow` (endless axis). */
  endMs: number;
  /** Pixels per day (from the active granularity). */
  px: number;
}

/**
 * Build the initial window around "today" and the dated rows. The origin sits a
 * fixed buffer before the earliest of {today, earliest task}; the end a buffer
 * after the latest of {today, latest task}. Crucially both today AND the tasks
 * are always inside, and the end is soft (extendable) — never a hard terminus.
 */
export function initialWindow(
  rows: readonly gantt.GanttRow[],
  gran: Granularity,
  nowMs: number = Date.now(),
): AxisWindow {
  const today = floorDayUtc(nowMs);
  let min = today;
  let max = today;
  for (const r of rows) {
    if (r.startsAt) min = Math.min(min, Date.parse(r.startsAt));
    if (r.endsAt) max = Math.max(max, Date.parse(r.endsAt));
  }
  const originMs = floorDayUtc(min) - PAST_BUFFER_DAYS * MS_PER_DAY;
  const endMs = floorDayUtc(max) + FUTURE_BUFFER_DAYS * MS_PER_DAY;
  return { originMs, endMs, px: PX_PER_DAY[gran] };
}

/** Grow the right edge by `days` (endless scroll). Origin never moves, so the
 *  current scrollLeft stays valid — no visual jump. */
export function extendWindow(w: AxisWindow, days: number = EXTEND_STEP_DAYS): AxisWindow {
  return { ...w, endMs: w.endMs + days * MS_PER_DAY };
}

/** Swap granularity while keeping the same date span. */
export function withGranularity(w: AxisWindow, gran: Granularity): AxisWindow {
  return { ...w, px: PX_PER_DAY[gran] };
}

export function xOf(ms: number, w: AxisWindow): number {
  return ((ms - w.originMs) / MS_PER_DAY) * w.px;
}

export function canvasWidth(w: AxisWindow): number {
  return xOf(w.endMs, w);
}

/** Inverse of xOf, snapped to a whole (day-floored) day — for click-to-create. */
export function dayAtX(x: number, w: AxisWindow): number {
  return floorDayUtc(w.originMs + (x / w.px) * MS_PER_DAY);
}

/** X of the "today" marker. Always defined (today is always inside the window). */
export function todayX(w: AxisWindow, nowMs: number = Date.now()): number {
  return xOf(nowMs, w);
}

/** Whole-day delta for a pixel drag at the current px scale. */
export function pxToDays(px: number, w: AxisWindow): number {
  return Math.round(px / w.px);
}

// ---- header tiers ----------------------------------------------------------

export interface AxisSegment {
  key: string;
  label: string;
  x: number;
  width: number;
}

function startOfMonthUtc(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
function addMonthsUtc(ms: number, n: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1);
}

/**
 * Top tier of the header. For day/week granularity it is the month
 * ("2026年8月"); for month granularity it is the year ("2026年").
 */
export function topSegments(w: AxisWindow, gran: Granularity): AxisSegment[] {
  const out: AxisSegment[] = [];
  if (gran === "month") {
    // year segments
    let y = new Date(w.originMs).getUTCFullYear();
    let cur = Date.UTC(y, 0, 1);
    while (cur < w.endMs) {
      const next = Date.UTC(y + 1, 0, 1);
      const segStart = Math.max(cur, w.originMs);
      const segEnd = Math.min(next, w.endMs);
      const x = xOf(segStart, w);
      out.push({ key: `y${y}`, label: `${y}年`, x, width: xOf(segEnd, w) - x });
      cur = next;
      y += 1;
    }
    return out;
  }
  // month segments
  let cur = startOfMonthUtc(w.originMs);
  while (cur < w.endMs) {
    const next = addMonthsUtc(cur, 1);
    const segStart = Math.max(cur, w.originMs);
    const segEnd = Math.min(next, w.endMs);
    const x = xOf(segStart, w);
    const d = new Date(cur);
    out.push({
      key: `m${d.getUTCFullYear()}-${d.getUTCMonth()}`,
      label: `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月`,
      x,
      width: xOf(segEnd, w) - x,
    });
    cur = next;
  }
  return out;
}

export interface AxisTick {
  key: string;
  ms: number;
  x: number;
  width: number;
  label: string;
  /** true when this cell is today (day gran) or contains today (week/month). */
  isToday: boolean;
}

/**
 * Bottom tier of the header. Granularity-specific:
 *  - day:   one cell per day (day-of-month number)
 *  - week:  one cell per week starting Monday (M/D of the Monday)
 *  - month: one cell per month (Japanese month name)
 */
export function bottomTicks(w: AxisWindow, gran: Granularity, nowMs: number = Date.now()): AxisTick[] {
  const today = floorDayUtc(nowMs);
  const out: AxisTick[] = [];
  if (gran === "day") {
    for (let ms = w.originMs; ms < w.endMs; ms += MS_PER_DAY) {
      const d = new Date(ms);
      out.push({
        key: `d${ms}`,
        ms,
        x: xOf(ms, w),
        width: w.px,
        label: String(d.getUTCDate()),
        isToday: ms === today,
      });
    }
    return out;
  }
  if (gran === "week") {
    // align to Monday: getUTCDay 0=Sun..6=Sat -> Monday offset
    let ms = w.originMs;
    const dow = new Date(ms).getUTCDay();
    const backToMon = (dow + 6) % 7;
    ms -= backToMon * MS_PER_DAY;
    for (; ms < w.endMs; ms += 7 * MS_PER_DAY) {
      const d = new Date(ms);
      const weekEnd = ms + 7 * MS_PER_DAY;
      out.push({
        key: `w${ms}`,
        ms,
        x: xOf(ms, w),
        width: w.px * 7,
        label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`,
        isToday: today >= ms && today < weekEnd,
      });
    }
    return out;
  }
  // month
  let cur = startOfMonthUtc(w.originMs);
  while (cur < w.endMs) {
    const next = addMonthsUtc(cur, 1);
    const d = new Date(cur);
    out.push({
      key: `mm${cur}`,
      ms: cur,
      x: xOf(cur, w),
      width: xOf(next, w) - xOf(cur, w),
      label: `${d.getUTCMonth() + 1}月`,
      isToday: today >= cur && today < next,
    });
    cur = next;
  }
  return out;
}

export interface WeekendBand {
  key: string;
  x: number;
  width: number;
}

/** Saturday/Sunday shading bands. Only meaningful at day/week scale (skipped at
 *  month scale, where a day is a few px and bands would look like noise). */
export function weekendBands(w: AxisWindow, gran: Granularity): WeekendBand[] {
  if (gran === "month") return [];
  const out: WeekendBand[] = [];
  for (let ms = w.originMs; ms < w.endMs; ms += MS_PER_DAY) {
    const dow = new Date(ms).getUTCDay();
    if (dow === 0 || dow === 6) {
      out.push({ key: `we${ms}`, x: xOf(ms, w), width: w.px });
    }
  }
  return out;
}

// ---- bar geometry ----------------------------------------------------------

export interface TimelineBar {
  taskId: string;
  hasBar: boolean; // false when start/end null (row kept, no bar)
  x: number;
  width: number;
  y: number; // top of the row
  progressPercent: number;
}

/** Minimum bar width so a same-day task stays grabbable. */
const MIN_BAR_PX = 16;

export function timelineBars(rows: readonly gantt.GanttRow[], w: AxisWindow): TimelineBar[] {
  return rows.map((r, i): TimelineBar => {
    const y = i * ROW_HEIGHT;
    if (!r.startsAt || !r.endsAt) {
      return { taskId: r.taskId, hasBar: false, x: 0, width: 0, y, progressPercent: r.progressPercent };
    }
    const start = Date.parse(r.startsAt);
    const end = Date.parse(r.endsAt);
    const x = xOf(start, w);
    const width = Math.max(xOf(end, w) - x, MIN_BAR_PX);
    return {
      taskId: r.taskId,
      hasBar: true,
      x,
      width,
      y,
      progressPercent: Math.max(0, Math.min(100, r.progressPercent)),
    };
  });
}

/** New ISO [start,end] after a whole-day move/resize. `mode` decides which edges
 *  shift: move slides both, resize-start/-end slides one (clamped so end>start). */
export function shiftBar(
  startsAt: string,
  endsAt: string,
  deltaDays: number,
  mode: "move" | "resize-start" | "resize-end",
): { startsAt: string; endsAt: string } {
  const s = Date.parse(startsAt);
  const e = Date.parse(endsAt);
  const d = deltaDays * MS_PER_DAY;
  let ns = s;
  let ne = e;
  if (mode === "move") {
    ns = s + d;
    ne = e + d;
  } else if (mode === "resize-start") {
    ns = Math.min(s + d, e - MS_PER_DAY); // keep at least 1 day
  } else {
    ne = Math.max(e + d, s + MS_PER_DAY);
  }
  return { startsAt: new Date(ns).toISOString(), endsAt: new Date(ne).toISOString() };
}
