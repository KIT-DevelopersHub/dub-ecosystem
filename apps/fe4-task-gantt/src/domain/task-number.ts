// Task ID numbers: `<team code>-<global creation sequence>` (e.g. "TK-0001").
//
// The number is a STABLE, creation-order attribute — NOT a view-time WBS label:
//  - The numeric part is the task's position in the GLOBAL creation sequence. When the
//    backend supplies an absolute `seqNo` (assigned once at creation, never reused) it
//    is used directly, so the number is a genuinely stable attribute — deleting or
//    re-teaming ANOTHER task never shifts this one. When no seqNo is present, we fall
//    back to a dense rank over the sequence basis (`idSeqAt ?? createdAt`, taskId as a
//    deterministic tie-break); that rank is still fully stable under filter / sort /
//    reorder because it is computed from fixed per-row attributes, never the display
//    order. Either way, that stability is what lets a predecessor be referenced by ID.
//  - The prefix is DERIVED from each row's owning team (統括 ⇒ "TK", …). A task with
//    no resolvable team gets the bare number.
//  - Changing a task's team assigns it a fresh (tail) seqNo / bumps its `idSeqAt`, so
//    it re-numbers `<new team code>-<next sequence>` — the old ID is retired (team
//    change = "delete old task, create a new one").
//
// Each number is zero-padded to a fixed width (`padWidth`): 4 ⇒ "TK-0001". Pass the
// FULL row set (not the filtered/sorted view) so the sequence is computed once over
// every task and stays consistent across every view. padWidth <= 1 disables padding.
import type { common, gantt } from "@dub/types";

/** taskId -> ID string (`<team code>-<seq>`) for the given rows.
 *  @param rows      the FULL, unfiltered row set (the sequence is global over all tasks).
 *  @param teamCodeOf resolves a row's 2-letter team code ("" ⇒ no prefix).
 *  @param padWidth  zero-pad width for the numeric part (0/1 ⇒ unpadded). */
export function computeTaskNumbers(
  rows: readonly gantt.GanttRow[],
  teamCodeOf: (row: gantt.GanttRow) => string,
  padWidth = 0,
): Map<common.TaskId, string> {
  const width = clampPadWidth(padWidth);
  // Rows carrying an absolute seqNo use it verbatim. Rows without one (a backend not
  // projecting seqNo, or an in-flight optimistic row) are placed at the TAIL in
  // creation order — starting just past the largest known seqNo — so a fresh task
  // always shows its final tail number and prod (no seqNo at all) collapses to a dense
  // 1..N creation-order rank. One coherent path serves both.
  let maxSeq = 0;
  for (const r of rows) if (typeof r.seqNo === "number") maxSeq = Math.max(maxSeq, r.seqNo);
  const tailSeq = new Map<common.TaskId, number>();
  const missing = rows.filter((r) => typeof r.seqNo !== "number").sort(compareByCreationOrder);
  missing.forEach((r, i) => tailSeq.set(r.taskId, maxSeq + i + 1));

  const out = new Map<common.TaskId, string>();
  for (const r of rows) {
    const n = typeof r.seqNo === "number" ? r.seqNo : tailSeq.get(r.taskId)!;
    const seq = String(n).padStart(width, "0");
    const code = teamCodeOf(r);
    out.set(r.taskId, code ? `${code}-${seq}` : seq);
  }
  return out;
}

/** The value a row is ranked by in the global creation sequence: a team change bumps
 *  `idSeqAt` to move the row to the tail; otherwise the task's `createdAt` fixes its
 *  place at creation. Empty string sorts first, so seed data without timestamps still
 *  falls back to a deterministic taskId order. */
function seqBasis(r: gantt.GanttRow): string {
  return (r.idSeqAt ?? r.createdAt ?? "") as string;
}

function compareByCreationOrder(a: gantt.GanttRow, b: gantt.GanttRow): number {
  const ka = seqBasis(a);
  const kb = seqBasis(b);
  if (ka !== kb) return ka < kb ? -1 : 1;
  // Deterministic tie-break (same timestamp, or both missing) keeps numbering stable.
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
}

/** Keep the pad width within a sane range (0/1 = no padding, up to MAX). Non-finite
 *  or negative inputs collapse to 0 so a bad stored value never breaks numbering. */
export function clampPadWidth(width: number): number {
  if (!Number.isFinite(width)) return 0;
  return Math.max(0, Math.min(MAX_PAD_WIDTH, Math.floor(width)));
}

export const DEFAULT_PAD_WIDTH = 4;
export const MAX_PAD_WIDTH = 6;
