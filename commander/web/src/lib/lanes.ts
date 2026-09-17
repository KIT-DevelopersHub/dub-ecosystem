// Lane derivation for the Commander board. No new state machine: a task's lane is a
// pure function of its feature phase + its latest run status + its task status. This
// composes the two existing truths (run status from the daemon, phase from the FSM)
// into the operator's kanban columns. Kept pure + separately tested so the board's
// core rule can't silently drift.
import type { BoardItem } from "./commanderApi.ts";

export type Lane = "queued" | "running" | "review" | "needs_fix" | "done";

export const LANES: readonly Lane[] = ["queued", "running", "review", "needs_fix", "done"];

export const LANE_LABELS: Record<Lane, string> = {
  queued: "投入待ち",
  running: "走行中",
  review: "確認待ち",
  needs_fix: "要修正",
  done: "完了",
};

/** Accent colour per lane (design §6 state-visibility cues). */
export const LANE_COLORS: Record<Lane, string> = {
  queued: "var(--dub-color-gray-400, #9aa4b6)",
  running: "var(--dub-color-info-500, #3b82f6)",
  review: "var(--dub-color-warning-500, #d0870b)",
  needs_fix: "var(--dub-color-danger-500, #e5484d)",
  done: "var(--dub-color-success-500, #30a46c)",
};

/**
 * Derive the board lane for one task.
 *
 * Order matters — it encodes precedence:
 *  1. done      = task archived (taskStatus done) OR feature shipped to prod.
 *  2. needs_fix = feature was rejected (demo/staging) OR the latest run failed.
 *  3. queued    = no run has been started yet.
 *  4. running   = latest run is pending/running.
 *  5. review    = latest run succeeded (awaiting the operator's approve/reject).
 */
export function deriveLane(item: BoardItem): Lane {
  if (item.taskStatus === "done" || item.featurePhase === "prod_shipped") return "done";
  if (item.featurePhase === "demo_rejected" || item.featurePhase === "staging_rejected") {
    return "needs_fix";
  }
  const run = item.latestRun;
  if (!run) return "queued";
  if (run.status === "failed") return "needs_fix";
  if (run.status === "pending" || run.status === "running") return "running";
  // run succeeded → ready for the operator to confirm.
  return "review";
}

/** Bucket every board item into its lane, preserving input (newest-first) order. */
export function groupByLane(items: BoardItem[]): Record<Lane, BoardItem[]> {
  const out: Record<Lane, BoardItem[]> = {
    queued: [],
    running: [],
    review: [],
    needs_fix: [],
    done: [],
  };
  for (const item of items) out[deriveLane(item)].push(item);
  return out;
}
