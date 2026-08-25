// WBS task numbers, derived purely from the CURRENT display order + the WBS tree
// (parentTaskId) already carried on each GanttRow. Nothing is persisted: the number
// is a view-time label, so re-ordering rows (drag / auto-sort) or re-parenting a
// task re-numbers automatically on the next render — exactly the WBS property that
// "順序依存" implies. No schema change, no server round-trip, $0.
//
// Format: `<prefix>-<n>` at the top level and `<prefix>-<n>-<m>[-…]` for children,
// e.g. prefix "AA" gives "AA-1", "AA-1-1", "AA-1-2", "AA-2". An empty prefix yields
// the bare hierarchy code ("1", "1-1"). Each numeric segment is zero-padded to a
// fixed width (`padWidth`): 4 digits gives "AA-0001", "AA-0001-0001", "AA-0002" — a
// fixed-width identifier that column-aligns. padWidth <= 1 disables padding. Rows are
// expected parent-before-child (the gantt always renders a parent immediately above
// its children); an orphaned row whose parent isn't present is numbered as a
// top-level entry so it never loses a label.
import type { common, gantt } from "@dub/types";

const ROOT_KEY = " root"; // sentinel sibling-group key for top-level rows

/** taskId -> hierarchical number string for the given ordered rows. */
export function computeTaskNumbers(
  rows: readonly gantt.GanttRow[],
  prefix = "",
  padWidth = 0,
): Map<common.TaskId, string> {
  const pathById = new Map<common.TaskId, number[]>();
  const siblingCounter = new Map<string, number>(); // parent group key -> last index used
  const out = new Map<common.TaskId, string>();
  const label = sanitizePrefix(prefix);
  const width = clampPadWidth(padWidth);

  for (const r of rows) {
    const parentId = r.parentTaskId ?? null;
    // Only treat as a child when the parent has already been numbered (keeps the
    // walk O(n) and cycle-proof — a forward/unknown ref just falls back to root).
    const parentNumbered = parentId != null && pathById.has(parentId);
    const parentPath = parentNumbered ? pathById.get(parentId)! : [];
    const groupKey = parentNumbered ? (parentId as string) : ROOT_KEY;
    const index = (siblingCounter.get(groupKey) ?? 0) + 1;
    siblingCounter.set(groupKey, index);

    const myPath = [...parentPath, index];
    pathById.set(r.taskId, myPath);
    const code = myPath.map((n) => String(n).padStart(width, "0")).join("-");
    out.set(r.taskId, label ? `${label}-${code}` : code);
  }
  return out;
}

/** Trim, drop inner whitespace, cap length — a prefix is a short label, not free text. */
export function sanitizePrefix(prefix: string): string {
  return prefix.replace(/\s+/g, "").slice(0, MAX_PREFIX_LEN);
}

/** Keep the pad width within a sane range (0/1 = no padding, up to MAX). Non-finite
 *  or negative inputs collapse to 0 so a bad stored value never breaks numbering. */
export function clampPadWidth(width: number): number {
  if (!Number.isFinite(width)) return 0;
  return Math.max(0, Math.min(MAX_PAD_WIDTH, Math.floor(width)));
}

export const MAX_PREFIX_LEN = 8;
export const DEFAULT_PREFIX = "AA";
export const DEFAULT_PAD_WIDTH = 4;
export const MAX_PAD_WIDTH = 6;
