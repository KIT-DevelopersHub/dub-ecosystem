// Sort grouping brackets — a pure VIEW overlay that turns the visible gantt rows
// into maximal contiguous runs that share a grouping key, so the left pane can draw
// a labelled bracket ("統括チーム", "高", …) down the right edge of each run. It is
// the read-only companion to row-sort.ts: row-sort re-sequences the rows by the
// chosen mode (so same-group rows end up adjacent), and this module collapses those
// adjacent rows into the ranges the bracket rail renders.
//
// It NEVER re-orders or drops a row — it only reads the (already sorted) sequence and
// its per-task group descriptor. Rows with no group entry (e.g. 手動/時期 modes, where
// grouping is off) simply break the current run and get no bracket, so the feature is
// entirely additive and disappears when the container passes no map.
import type { common, gantt } from "@dub/types";

export interface RowGroup {
  /** Stable grouping key (teamId / priority value / a sentinel). Runs break when it changes. */
  key: string;
  /** User-facing bracket label ("統括チーム", "高", "チーム未設定", …). */
  label: string;
  /** Accent colour for the bracket + label (team colour, or undefined for a neutral). */
  color?: string;
}

export interface GroupRun extends RowGroup {
  /** Index of the run's first row within the visible rows array. */
  startIndex: number;
  /** Number of contiguous rows the run spans. */
  length: number;
}

/**
 * Collapse `rows` into maximal contiguous runs of rows that share a group `key`.
 * A row missing from `groupById` breaks the current run and is left un-bracketed.
 * Returns [] when there is nothing to group (no map, empty map), so the caller can
 * cheaply skip rendering the rail.
 */
export function groupRuns(
  rows: readonly gantt.GanttRow[],
  groupById: ReadonlyMap<common.TaskId, RowGroup> | undefined,
): GroupRun[] {
  if (!groupById || groupById.size === 0) return [];
  const runs: GroupRun[] = [];
  let i = 0;
  while (i < rows.length) {
    const g = groupById.get(rows[i]!.taskId);
    if (!g) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < rows.length) {
      const next = groupById.get(rows[j]!.taskId);
      if (!next || next.key !== g.key) break;
      j += 1;
    }
    runs.push({ key: g.key, label: g.label, ...(g.color ? { color: g.color } : {}), startIndex: i, length: j - i });
    i = j;
  }
  return runs;
}
