// Marquee (range-drag) multi-select geometry for the gantt timeline.
//
// PowerPoint-style: the user drags a rectangle over the empty timeline canvas and
// every task bar the rectangle touches becomes selected. All the maths here is pure
// (no DOM) so it is unit-testable — the component owns the pointer session and maps
// clientX/Y into the body-relative coordinates this module consumes.
import type { common } from "@dub/types";
import { ROW_HEIGHT, type TimelineBar } from "./timeline-axis";

/** A rectangle in tlBody-local coordinates (origin = the body's top-left). */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Normalise two drag corners into a rect with x0<=x1 and y0<=y1. */
export function normalizeRect(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    x0: Math.min(a.x, b.x),
    y0: Math.min(a.y, b.y),
    x1: Math.max(a.x, b.x),
    y1: Math.max(a.y, b.y),
  };
}

/** True when the drag has moved far enough to be a marquee (vs a plain click). */
export function rectIsDrag(r: Rect, threshold = 4): boolean {
  return r.x1 - r.x0 > threshold || r.y1 - r.y0 > threshold;
}

/** 1-D overlap test for half-open-ish spans (inclusive; a touch counts). */
function overlaps(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 <= b1 && b0 <= a1;
}

/**
 * Ids of the bars the rectangle touches. A bar is selected when the rect overlaps
 * BOTH its horizontal span [x, x+width] and its row band [y, y+ROW_HEIGHT] (the full
 * row height, so a shallow horizontal sweep across a row still grabs it). Rows with
 * no bar (undated) are never selectable. Order follows the input bar order.
 */
export function barsInRect(
  bars: readonly TimelineBar[],
  rect: Rect,
  rowHeight: number = ROW_HEIGHT,
): common.TaskId[] {
  const out: common.TaskId[] = [];
  for (const b of bars) {
    if (!b.hasBar) continue;
    const rowTop = b.y;
    const rowBottom = b.y + rowHeight;
    if (overlaps(b.x, b.x + b.width, rect.x0, rect.x1) && overlaps(rowTop, rowBottom, rect.y0, rect.y1)) {
      out.push(b.taskId as common.TaskId);
    }
  }
  return out;
}

/** Union two id lists into a deduped set-preserving array (existing first). */
export function unionIds(
  existing: ReadonlySet<common.TaskId>,
  add: readonly common.TaskId[],
): Set<common.TaskId> {
  const next = new Set(existing);
  for (const id of add) next.add(id);
  return next;
}
