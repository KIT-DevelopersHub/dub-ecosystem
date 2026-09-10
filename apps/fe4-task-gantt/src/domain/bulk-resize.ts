// Multi-select bulk RESIZE (複数選択の一括リサイズ): dragging the edge handle on a
// marquee selection's bounding box stretches every selected task by the SAME
// whole-day delta (等量デルタ — a plain per-task date shift, not a proportional
// scale; simplest to reason about and matches how the existing single-bar resize
// already works). Right edge shifts each task's END; left edge shifts each
// task's START.
//
// A leaf task's own row is resized directly. A WBS parent's span is DERIVED from
// its children (the read model returns the parent's own dates as null — see
// scaleChildrenForParentResize in timeline-axis.ts), so persisting a parent's own
// row is discarded on the next GET and the bar snaps back. A selected parent
// therefore SCALES its descendants instead — the exact mechanism the single-
// parent resize already uses — so each parent guards its own minimum 1-day span
// independently of the leaves.
//
// The shared delta itself is clamped ONCE, up front, against the tightest dated
// LEAF root in the selection so no leaf inverts (start > end) — the min-length
// guard (判断: 複数選択の一括リサイズ). A very short leaf never distorts an
// unrelated parent's scale, since parents keep their own existing clamp.
import { MS_PER_DAY, rollupRowDates, scaleChildrenForParentResize } from "./timeline-axis";
import type { gantt } from "@dub/types";

export interface BulkResizeRow {
  taskId: string;
  startsAt: string | null;
  endsAt: string | null;
  parentTaskId?: string | null;
  hasChildren?: boolean;
}

export interface BulkResizeWrite {
  taskId: string;
  startsAt: string;
  endsAt: string;
}

export interface BulkResizePlan {
  /** the whole-day delta actually applied to LEAVES after the min-length clamp
   *  (0 ⇒ the tightest leaf was already at the 1-day floor — no leaf writes,
   *  though selected parents may still scale if their own guard allows it). */
  deltaDays: number;
  writes: BulkResizeWrite[];
}

/** Clamp a shared resize delta so no dated leaf in `durationsDays` (whole days,
 *  end-start) would shrink below a 1-day span. Pure; reused for the live drag
 *  preview and for the commit, so both agree on the same bound. */
export function clampBulkResizeDelta(
  durationsDays: readonly number[],
  edge: "start" | "end",
  deltaDays: number,
): number {
  if (durationsDays.length === 0) return deltaDays;
  const minDuration = Math.min(...durationsDays);
  if (edge === "end") return Math.max(deltaDays, 1 - minDuration);
  return Math.min(deltaDays, minDuration - 1);
}

/**
 * Plan a bulk resize commit.
 *
 * `rawRows` = the live row set as returned by the API (a WBS parent's OWN
 * startsAt/endsAt may be null — only its children carry real dates). `rolledRows`
 * = `rollupRowDates(rawRows)` (parents' dates rolled up to the union of their
 * descendants) — used only to read a selected PARENT's own effective span, the
 * same way the single-parent resize does. `rootIds` must already be de-duplicated
 * against nesting (see `selectionRoots`) so a selected descendant of another
 * selected parent is not resized twice.
 */
export function planBulkResize(
  rawRows: readonly BulkResizeRow[],
  rolledRows: readonly BulkResizeRow[],
  rootIds: readonly string[],
  edge: "start" | "end",
  deltaDays: number,
): BulkResizePlan {
  const rawById = new Map(rawRows.map((r) => [r.taskId, r]));
  const rolledById = new Map(rolledRows.map((r) => [r.taskId, r]));

  const leafRoots = rootIds
    .map((id) => rawById.get(id))
    .filter((r): r is BulkResizeRow => !!r && !r.hasChildren && !!r.startsAt && !!r.endsAt);
  const durations = leafRoots.map((r) => (Date.parse(r.endsAt!) - Date.parse(r.startsAt!)) / MS_PER_DAY);
  const clamped = clampBulkResizeDelta(durations, edge, deltaDays);

  const writes: BulkResizeWrite[] = [];
  if (clamped !== 0) {
    for (const r of leafRoots) {
      const s = Date.parse(r.startsAt!);
      const e = Date.parse(r.endsAt!);
      const ns = edge === "start" ? s + clamped * MS_PER_DAY : s;
      const ne = edge === "end" ? e + clamped * MS_PER_DAY : e;
      writes.push({ taskId: r.taskId, startsAt: new Date(ns).toISOString(), endsAt: new Date(ne).toISOString() });
    }
  }

  const parentRoots = rootIds.map((id) => rawById.get(id)).filter((r): r is BulkResizeRow => !!r && !!r.hasChildren);
  if (parentRoots.length > 0 && deltaDays !== 0) {
    for (const p of parentRoots) {
      const rp = rolledById.get(p.taskId);
      if (!rp?.startsAt || !rp?.endsAt) continue;
      // BFS the subtree (any depth) to collect every descendant.
      const ids: string[] = [p.taskId];
      for (let i = 0; i < ids.length; i++) {
        for (const r of rawRows) if (r.parentTaskId === ids[i]) ids.push(r.taskId);
      }
      const descendants = ids.slice(1).map((id) => {
        const r = rawById.get(id);
        return { taskId: id, startsAt: r?.startsAt ?? null, endsAt: r?.endsAt ?? null };
      });
      const scaled = scaleChildrenForParentResize(
        { startsAt: rp.startsAt, endsAt: rp.endsAt },
        descendants,
        edge,
        deltaDays,
      );
      writes.push(...scaled);
    }
  }

  return { deltaDays: clamped, writes };
}

/** Convenience wrapper for callers that already hold `gantt.GanttRow[]` (the
 *  container's live cache) — rolls it up once and forwards to `planBulkResize`. */
export function planBulkResizeFromRows(
  rows: readonly gantt.GanttRow[],
  rootIds: readonly string[],
  edge: "start" | "end",
  deltaDays: number,
): BulkResizePlan {
  return planBulkResize(rows, rollupRowDates(rows), rootIds, edge, deltaDays);
}
