// Pure gantt geometry over the frozen `gantt.GanttChartDTO`. The DTO is already
// integrated to render units, so this stays thin (CSS Grid + SVG self-draw, no
// chart lib — design §2-2). Handles null-date rows (bar absent, row kept —
// test 7) and FS dependency violation flags.
import type { gantt, common } from "@dub/types";

const MS_PER_DAY = 86_400_000;

export const PX_PER_DAY: Record<gantt.GanttZoom, number> = {
  day: 40,
  week: 12,
  month: 4,
};

export interface DateBounds {
  minMs: number;
  maxMs: number;
}

function dayFloorUtc(ms: number): number {
  return Math.floor(ms / MS_PER_DAY) * MS_PER_DAY;
}

/** Overall date span across all dated rows (+1 day pad on the end). null if none. */
export function computeDateBounds(rows: readonly gantt.GanttRow[]): DateBounds | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const r of rows) {
    if (r.startsAt) min = Math.min(min, Date.parse(r.startsAt));
    if (r.endsAt) max = Math.max(max, Date.parse(r.endsAt));
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { minMs: dayFloorUtc(min), maxMs: dayFloorUtc(max) + MS_PER_DAY };
}

export interface BarBox {
  taskId: common.TaskId;
  hasBar: boolean; // false when startsAt/endsAt is null (row still listed)
  x: number;
  width: number;
  y: number;
  progressWidth: number;
  progressPercent: number;
  isCritical: boolean; // on the CPM critical path (zero slack) — coloured distinctly
}

export interface GanttGeometryOptions {
  zoom: gantt.GanttZoom;
  rowHeight: number; // px
  minBarWidth?: number; // px, so a same-day bar is still clickable
}

export function ganttGeometry(
  rows: readonly gantt.GanttRow[],
  bounds: DateBounds,
  opts: GanttGeometryOptions,
  criticalIds?: ReadonlySet<common.TaskId>,
): BarBox[] {
  const pxPerDay = PX_PER_DAY[opts.zoom];
  const minW = opts.minBarWidth ?? 4;
  return rows.map((r, i): BarBox => {
    const y = i * opts.rowHeight;
    const isCritical = criticalIds?.has(r.taskId) ?? false;
    if (!r.startsAt || !r.endsAt) {
      return { taskId: r.taskId, hasBar: false, x: 0, width: 0, y, progressWidth: 0, progressPercent: r.progressPercent, isCritical };
    }
    const start = Date.parse(r.startsAt);
    const end = Date.parse(r.endsAt);
    const x = ((start - bounds.minMs) / MS_PER_DAY) * pxPerDay;
    const rawW = ((end - start) / MS_PER_DAY) * pxPerDay;
    const width = Math.max(rawW, minW);
    const pct = Math.max(0, Math.min(100, r.progressPercent));
    return {
      taskId: r.taskId,
      hasBar: true,
      x,
      width,
      y,
      progressWidth: (width * pct) / 100,
      progressPercent: pct,
      isCritical,
    };
  });
}

/** X of the "today" marker within the canvas, or null when today is off-span. */
export function todayLineX(bounds: DateBounds, zoom: gantt.GanttZoom, nowMs: number = Date.now()): number | null {
  if (nowMs < bounds.minMs || nowMs > bounds.maxMs) return null;
  return ((nowMs - bounds.minMs) / MS_PER_DAY) * PX_PER_DAY[zoom];
}

export interface DependencySegment {
  id: string;
  fromTaskId: common.TaskId;
  toTaskId: common.TaskId;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  isViolated: boolean; // FS: successor starts before predecessor finishes (+lag)
}

/** SVG segments linking predecessor bar-end to successor bar-start (FS only, P0). */
export function dependencySegments(
  deps: readonly gantt.GanttDependencyLine[],
  boxes: readonly BarBox[],
  rows: readonly gantt.GanttRow[],
  rowHeight: number,
): DependencySegment[] {
  const boxById = new Map(boxes.map((b) => [b.taskId, b]));
  const rowById = new Map(rows.map((r) => [r.taskId, r]));
  const out: DependencySegment[] = [];
  for (const d of deps) {
    const from = boxById.get(d.fromTaskId);
    const to = boxById.get(d.toTaskId);
    if (!from || !to || !from.hasBar || !to.hasBar) continue;
    const fromRow = rowById.get(d.fromTaskId);
    const toRow = rowById.get(d.toTaskId);
    let isViolated = false;
    if (fromRow?.endsAt && toRow?.startsAt) {
      const predEnd = Date.parse(fromRow.endsAt) + d.lagDays * MS_PER_DAY;
      isViolated = Date.parse(toRow.startsAt) < predEnd;
    }
    out.push({
      id: d.id,
      fromTaskId: d.fromTaskId,
      toTaskId: d.toTaskId,
      x1: from.x + from.width,
      y1: from.y + rowHeight / 2,
      x2: to.x,
      y2: to.y + rowHeight / 2,
      isViolated,
    });
  }
  return out;
}

export interface TimelineTick {
  ms: number;
  x: number;
  label: string;
}

/** Tick marks across the span; granularity follows zoom. */
export function timelineTicks(bounds: DateBounds, zoom: gantt.GanttZoom): TimelineTick[] {
  const pxPerDay = PX_PER_DAY[zoom];
  const stepDays = zoom === "day" ? 1 : zoom === "week" ? 7 : 30;
  const ticks: TimelineTick[] = [];
  for (let ms = bounds.minMs; ms <= bounds.maxMs; ms += stepDays * MS_PER_DAY) {
    const x = ((ms - bounds.minMs) / MS_PER_DAY) * pxPerDay;
    ticks.push({ ms, x, label: new Date(ms).toISOString().slice(0, 10) });
  }
  return ticks;
}

/** Rows to render given a collapse set. No hierarchy in P0 DTO, so collapse is
 *  a per-row flag consumers can use to shrink a bar; visibility is unchanged. */
export function isCollapsed(taskId: common.TaskId, collapsed: readonly common.TaskId[]): boolean {
  return collapsed.includes(taskId);
}

/** WBS visibility over the FULL ancestor chain. A row is shown only when EVERY
 *  ancestor on its `parentTaskId` chain is open (present in `openParents`). Any
 *  collapsed ancestor hides the whole subtree — regardless of a descendant's own
 *  toggle state, so a grandchild can never outlive a collapsed grandparent
 *  ("祖先が閉じていれば子孫は絶対に見えない"). Each node's own open/closed state is
 *  left untouched, so re-opening an ancestor restores the subtree exactly as the
 *  user last left it (a child that was open comes back open). Pure; cycle-guarded. */
export function visibleTreeRows<R extends { taskId: common.TaskId; parentTaskId?: common.TaskId | null }>(
  rows: readonly R[],
  openParents: ReadonlySet<common.TaskId>,
): R[] {
  const byId = new Map(rows.map((r) => [r.taskId, r] as const));
  return rows.filter((r) => {
    let pid = r.parentTaskId ?? null;
    const seen = new Set<common.TaskId>();
    while (pid) {
      if (!openParents.has(pid)) return false; // a collapsed ancestor hides this row
      if (seen.has(pid)) break; // defensive: never loop on a malformed cycle
      seen.add(pid);
      pid = byId.get(pid)?.parentTaskId ?? null;
    }
    return true;
  });
}

/** Bar D&D: shift start/end by a day delta, returning the new ISO dates. Used to
 *  build the PATCH dueAt (and startAt when task gains it — 8-10/§9). */
export function shiftDatesByDays(
  startsAt: common.ISODateTime | null,
  endsAt: common.ISODateTime | null,
  deltaDays: number,
): { startsAt: common.ISODateTime | null; endsAt: common.ISODateTime | null } {
  const shift = (v: string | null): string | null =>
    v === null ? null : new Date(Date.parse(v) + deltaDays * MS_PER_DAY).toISOString();
  return { startsAt: shift(startsAt), endsAt: shift(endsAt) };
}

/** Pixel delta -> whole-day delta for a given zoom (drag quantization). */
export function pxToDayDelta(px: number, zoom: gantt.GanttZoom): number {
  return Math.round(px / PX_PER_DAY[zoom]);
}
