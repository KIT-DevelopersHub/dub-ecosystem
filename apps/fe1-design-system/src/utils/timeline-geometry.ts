// Pure geometry for the Timeline/Gantt primitive. Framework- and data-agnostic:
// operates on plain epoch-ms numbers so FE1 stays a leaf package (no @dub/types).
// Mirrors the math FE4 previously kept in its own gantt-layout module, hoisted here
// so consumers can delete that copy and reuse the exact same units.
import type { TimelineScale, TimelineRow, TimelineDependency } from "../types";

const MS_PER_DAY = 86_400_000;

/** Horizontal density per calendar day for each scale (px). */
export const TIMELINE_PX_PER_DAY: Record<TimelineScale, number> = {
  day: 40,
  week: 12,
  month: 4,
};

export interface TimelineBounds {
  minMs: number;
  maxMs: number;
}

function dayFloorUtc(ms: number): number {
  return Math.floor(ms / MS_PER_DAY) * MS_PER_DAY;
}

/** Overall span across all dated rows (day-floored, +1 day end pad). null if none. */
export function computeTimelineBounds(rows: readonly TimelineRow[]): TimelineBounds | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const r of rows) {
    if (r.startMs != null) min = Math.min(min, r.startMs);
    if (r.endMs != null) max = Math.max(max, r.endMs);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { minMs: dayFloorUtc(min), maxMs: dayFloorUtc(max) + MS_PER_DAY };
}

export interface TimelineBar {
  id: string;
  hasBar: boolean; // false when startMs/endMs is null (row still listed)
  x: number;
  width: number;
  y: number;
  progressWidth: number;
  progressPercent: number;
}

export interface TimelineBarsOptions {
  scale: TimelineScale;
  rowHeight: number; // px
  minBarWidth?: number; // px, default 4 — keeps a same-day bar clickable
}

export function timelineBars(
  rows: readonly TimelineRow[],
  bounds: TimelineBounds,
  opts: TimelineBarsOptions,
): TimelineBar[] {
  const pxPerDay = TIMELINE_PX_PER_DAY[opts.scale];
  const minW = opts.minBarWidth ?? 4;
  return rows.map((r, i): TimelineBar => {
    const y = i * opts.rowHeight;
    const pct = Math.max(0, Math.min(100, r.progressPercent ?? 0));
    if (r.startMs == null || r.endMs == null) {
      return { id: r.id, hasBar: false, x: 0, width: 0, y, progressWidth: 0, progressPercent: pct };
    }
    const x = ((r.startMs - bounds.minMs) / MS_PER_DAY) * pxPerDay;
    const rawW = ((r.endMs - r.startMs) / MS_PER_DAY) * pxPerDay;
    const width = Math.max(rawW, minW);
    return { id: r.id, hasBar: true, x, width, y, progressWidth: (width * pct) / 100, progressPercent: pct };
  });
}

export interface TimelineTick {
  ms: number;
  x: number;
  label: string; // ISO date (YYYY-MM-DD)
}

/** Evenly-spaced tick marks across the span; granularity follows the scale. */
export function timelineTicks(bounds: TimelineBounds, scale: TimelineScale): TimelineTick[] {
  const pxPerDay = TIMELINE_PX_PER_DAY[scale];
  const stepDays = scale === "day" ? 1 : scale === "week" ? 7 : 30;
  const ticks: TimelineTick[] = [];
  for (let ms = bounds.minMs; ms <= bounds.maxMs; ms += stepDays * MS_PER_DAY) {
    const x = ((ms - bounds.minMs) / MS_PER_DAY) * pxPerDay;
    ticks.push({ ms, x, label: new Date(ms).toISOString().slice(0, 10) });
  }
  return ticks;
}

export interface TimelineSegment {
  id: string;
  fromId: string;
  toId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  violated: boolean;
}

/** SVG segments linking predecessor bar-end to successor bar-start. Deps whose
 *  endpoints have no bar (unscheduled) are skipped. */
export function timelineDependencySegments(
  deps: readonly TimelineDependency[],
  bars: readonly TimelineBar[],
  rowHeight: number,
): TimelineSegment[] {
  const byId = new Map(bars.map((b) => [b.id, b]));
  const out: TimelineSegment[] = [];
  for (const d of deps) {
    const from = byId.get(d.fromId);
    const to = byId.get(d.toId);
    if (!from || !to || !from.hasBar || !to.hasBar) continue;
    out.push({
      id: d.id,
      fromId: d.fromId,
      toId: d.toId,
      x1: from.x + from.width,
      y1: from.y + rowHeight / 2,
      x2: to.x,
      y2: to.y + rowHeight / 2,
      violated: d.violated ?? false,
    });
  }
  return out;
}

/** Pixel drag delta → whole-day delta for a scale (bar D&D quantization). */
export function pxToDayDelta(px: number, scale: TimelineScale): number {
  return Math.round(px / TIMELINE_PX_PER_DAY[scale]);
}

/** Shift an epoch-ms value (or null) by whole days. Used to build PATCH dates. */
export function shiftMsByDays(ms: number | null, deltaDays: number): number | null {
  return ms == null ? null : ms + deltaDays * MS_PER_DAY;
}
