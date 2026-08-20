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

/**
 * Roll parent (work-package) rows up to the union of their descendants' spans.
 *
 * WBS parents own a stored date range, but a parent bar must ALWAYS enclose its
 * children (feedback #2): widen a child and the parent (and thus the axis) grow;
 * a manually-narrowed parent never "splits" a child. This derives that invariant
 * purely — children are untouched, each parent's start/end becomes
 * min/max(own, all descendants). Processed deepest-first so multi-level trees
 * roll up correctly. Original row order is preserved.
 */
export function rollupRowDates(rows: readonly gantt.GanttRow[]): gantt.GanttRow[] {
  const childrenOf = new Map<string, string[]>();
  for (const r of rows) {
    if (r.parentTaskId) {
      const arr = childrenOf.get(r.parentTaskId);
      if (arr) arr.push(r.taskId);
      else childrenOf.set(r.parentTaskId, [r.taskId]);
    }
  }
  // No hierarchy => nothing to roll up; return the input untouched.
  if (childrenOf.size === 0) return rows as gantt.GanttRow[];

  const byId = new Map(rows.map((r) => [r.taskId, { ...r }]));
  const deepestFirst = [...rows].sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0));
  for (const r of deepestFirst) {
    const kids = childrenOf.get(r.taskId);
    if (!kids || kids.length === 0) continue;
    const self = byId.get(r.taskId)!;
    let min = self.startsAt ? Date.parse(self.startsAt) : Number.POSITIVE_INFINITY;
    let max = self.endsAt ? Date.parse(self.endsAt) : Number.NEGATIVE_INFINITY;
    for (const cid of kids) {
      const c = byId.get(cid)!; // already rolled up (deepest-first)
      if (c.startsAt) min = Math.min(min, Date.parse(c.startsAt));
      if (c.endsAt) max = Math.max(max, Date.parse(c.endsAt));
    }
    if (Number.isFinite(min)) self.startsAt = new Date(min).toISOString();
    if (Number.isFinite(max)) self.endsAt = new Date(max).toISOString();
  }
  return rows.map((r) => byId.get(r.taskId)!);
}

/**
 * A parent (work-package) enclosure: the vertical band a parent bar grows to
 * cover so it visually CONTAINS its (visible) descendant rows — the "内包" look.
 *
 * Pure geometry over the *visible* rows: a parent's descendants always render as
 * a contiguous run immediately after it (children only appear when the parent is
 * open, depth-first), so the enclosure is [parentRow .. lastRow with depth > the
 * parent's depth]. Using `depth` (not direct `parentTaskId`) is what makes 3–4
 * level nesting work — a grandparent's run keeps counting THROUGH an inner
 * parent's own children instead of stopping at the first non-direct-child.
 *
 * `rowStart`/`rowCount` are row indices/counts; `top`/`height` are the px band.
 * A parent whose children are collapsed (no deeper rows follow) yields nothing —
 * folded parents fall back to the ordinary 1-row bar. The horizontal extent
 * (start/end) is the parent bar's own span and is applied by the view.
 */
export interface ParentEnclosure {
  taskId: string;
  depth: number;
  rowStart: number;
  rowCount: number; // parent row + its visible descendants
  top: number;
  height: number;
}

export function parentEnclosures(rows: readonly gantt.GanttRow[]): ParentEnclosure[] {
  const out: ParentEnclosure[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (!r.hasChildren) continue;
    const depth = r.depth ?? 0;
    let n = 0;
    for (let j = i + 1; j < rows.length; j++) {
      if ((rows[j]!.depth ?? 0) > depth) n += 1;
      else break;
    }
    if (n > 0) {
      out.push({
        taskId: r.taskId,
        depth,
        rowStart: i,
        rowCount: n + 1,
        top: i * ROW_HEIGHT,
        height: (n + 1) * ROW_HEIGHT,
      });
    }
  }
  return out;
}

/** Minimum bar width so a same-day task stays grabbable. */
const MIN_BAR_PX = 16;

export function timelineBars(rows: readonly gantt.GanttRow[], w: AxisWindow): TimelineBar[] {
  return rows.map((r, i): TimelineBar => {
    const y = i * ROW_HEIGHT;
    if (!r.startsAt || !r.endsAt) {
      return { taskId: r.taskId, hasBar: false, x: 0, width: 0, y, progressPercent: r.progressPercent };
    }
    // Inclusive span: a task covers BOTH its start and end days, so the bar must
    // paint (end - start + 1) day-cells. Floor to day, then extend the right edge by
    // one day (exclusive) so the end day's own cell is filled. Fixes the off-by-one
    // where e.g. a 08-05→08-08 task (4 days) rendered only 3 cells.
    const startDay = floorDayUtc(Date.parse(r.startsAt));
    const endDayExclusive = floorDayUtc(Date.parse(r.endsAt)) + MS_PER_DAY;
    const x = xOf(startDay, w);
    const width = Math.max(xOf(endDayExclusive, w) - x, MIN_BAR_PX);
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

export interface ChildSchedule {
  taskId: string;
  startsAt: string | null;
  endsAt: string | null;
}

/**
 * Resizing a work-package (parent) BAR at one edge, expressed as child moves.
 *
 * A parent's span is the rollup of its children — the read model returns the parent's OWN
 * dates as null — so we cannot persist the parent's own row (the next GET discards it and
 * the bar snaps back). Instead we SCALE every dated descendant proportionally about the
 * OPPOSITE edge so the rolled span reaches the dragged edge; those child writes persist and
 * roll the parent bar up to match. Whole-day arithmetic, minimum 1-day child span.
 *
 * `edge` = the handle grabbed; `deltaDays` = whole-day drag at that edge (＋ grows the span
 * there). Returns only the descendants whose [start,end] actually changes. Pure.
 */
export function scaleChildrenForParentResize(
  parentSpan: { startsAt: string; endsAt: string },
  descendants: readonly ChildSchedule[],
  edge: "start" | "end",
  deltaDays: number,
): { taskId: string; startsAt: string; endsAt: string }[] {
  const pStart = Date.parse(parentSpan.startsAt);
  const pEnd = Date.parse(parentSpan.endsAt);
  const span = pEnd - pStart;
  if (!(span > 0) || deltaDays === 0) return [];
  const dated = descendants.filter(
    (d): d is { taskId: string; startsAt: string; endsAt: string } => !!d.startsAt && !!d.endsAt,
  );
  if (dated.length === 0) return [];

  // Anchor at the opposite edge; f = newSpan / oldSpan (clamped so the span never inverts).
  let anchor: number;
  let f: number;
  if (edge === "end") {
    const newEnd = Math.max(pEnd + deltaDays * MS_PER_DAY, pStart + MS_PER_DAY);
    anchor = pStart;
    f = (newEnd - anchor) / span;
  } else {
    const newStart = Math.min(pStart + deltaDays * MS_PER_DAY, pEnd - MS_PER_DAY);
    anchor = pEnd;
    f = (anchor - newStart) / span;
  }
  const roundDay = (ms: number) => Math.round(ms / MS_PER_DAY) * MS_PER_DAY;

  const out: { taskId: string; startsAt: string; endsAt: string }[] = [];
  for (const c of dated) {
    const cs = Date.parse(c.startsAt);
    const ce = Date.parse(c.endsAt);
    let ns: number;
    let ne: number;
    if (edge === "end") {
      ns = anchor + roundDay((cs - anchor) * f);
      ne = anchor + roundDay((ce - anchor) * f);
    } else {
      ns = anchor - roundDay((anchor - cs) * f);
      ne = anchor - roundDay((anchor - ce) * f);
    }
    if (ne <= ns) ne = ns + MS_PER_DAY; // keep at least a 1-day child span
    const nsIso = new Date(ns).toISOString();
    const neIso = new Date(ne).toISOString();
    if (nsIso !== c.startsAt || neIso !== c.endsAt) out.push({ taskId: c.taskId, startsAt: nsIso, endsAt: neIso });
  }
  return out;
}
