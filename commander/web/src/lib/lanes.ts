// Lane derivation for the Commander board. No new state machine: a task's lane is a
// pure function of its feature phase + its latest run status + its task status. This
// composes the two existing truths (run status from the daemon, phase from the FSM)
// into the operator's kanban columns. Kept pure + separately tested so the board's
// core rule can't silently drift.
import type { BoardItem, FeaturePhase } from "./commanderApi.ts";

export type Lane =
  | "queued"
  | "implementing"
  | "review"
  | "staging_deploying"
  | "staging_review"
  | "prod_deploying"
  | "prod_review"
  | "done";

export const LANES: readonly Lane[] = [
  "queued",
  "implementing",
  "review",
  "staging_deploying",
  "staging_review",
  "prod_deploying",
  "prod_review",
  "done",
];

export const LANE_LABELS: Record<Lane, string> = {
  queued: "投入待ち",
  implementing: "実装中",
  review: "確認待ち",
  staging_deploying: "stg反映中",
  staging_review: "stg確認待ち",
  prod_deploying: "本番反映中",
  prod_review: "本番確認中",
  done: "完了",
};

const RUNNING = "var(--dub-color-info-500, #3b82f6)";
const REVIEW = "var(--dub-color-warning-500, #d0870b)";

/** Accent colour per lane (design §6 state-visibility cues). */
export const LANE_COLORS: Record<Lane, string> = {
  queued: "var(--dub-color-gray-400, #9aa4b6)",
  implementing: RUNNING,
  review: REVIEW,
  staging_deploying: RUNNING,
  staging_review: REVIEW,
  prod_deploying: RUNNING,
  prod_review: "var(--dub-color-success-500, #30a46c)",
  // アーカイブ済は"もう触らない"列なので彩度を落とす（本番確認中の緑と混同させない）。
  done: "var(--dub-color-gray-500, #6b7280)",
};

/** 要修正(却下 or run 失敗)の強調色。専用列は持たず、その段の確認列でカードを赤く見せる。 */
export const NEEDS_FIX_COLOR = "var(--dub-color-danger-500, #e5484d)";

/** run が走っている列（走行中カウント・中止ボタンの判定に使う）。 */
const RUNNING_LANES: readonly Lane[] = ["implementing", "staging_deploying", "prod_deploying"];
/** オペレーターの判断待ち列（承認/却下ボタンの判定に使う）。 */
const REVIEW_LANES: readonly Lane[] = ["review", "staging_review", "prod_review"];

export function isRunningLane(lane: Lane): boolean {
  return RUNNING_LANES.includes(lane);
}

export function isReviewLane(lane: Lane): boolean {
  return REVIEW_LANES.includes(lane);
}

/** アーカイブ済み（ユーザーが明示的に「完了」した）タスクか。 */
export function isArchived(item: BoardItem): boolean {
  return item.taskStatus === "done";
}

/** 却下された or 最新 run が失敗した = 修正して再実行が要るタスクか。 */
export function needsFix(item: BoardItem): boolean {
  if (isArchived(item)) return false;
  if (item.featurePhase === "demo_rejected" || item.featurePhase === "staging_rejected") {
    return true;
  }
  return item.latestRun?.status === "failed";
}

type Stage = "demo" | "staging" | "prod";

function stageOf(phase: FeaturePhase): Stage {
  if (phase === "prod_shipped") return "prod";
  if (phase === "staging_deployed" || phase === "staging_review" || phase === "staging_rejected") {
    return "staging";
  }
  return "demo";
}

const STAGE_LANES: Record<Stage, { running: Lane; review: Lane }> = {
  demo: { running: "implementing", review: "review" },
  staging: { running: "staging_deploying", review: "staging_review" },
  prod: { running: "prod_deploying", review: "prod_review" },
};

/**
 * Derive the board lane for one task.
 *
 * Order matters — it encodes precedence:
 *  1. done    = task archived (taskStatus done) — the ONLY way into 完了. フェーズは終了条件
 *               ではない（本番確認中もまだ生きていて追加指示を出せる）。
 *  2. queued  = demo 段でまだ run が無い。
 *  3. 〜中    = 最新 run が pending/running → その段の 実装中 / stg反映中 / 本番反映中。
 *  4. 〜確認  = それ以外（成功・失敗・却下）→ その段の 確認待ち / stg確認待ち / 本番確認中。
 *               失敗・却下は専用列を持たず、ボールがオペレーター側の確認列に置いて
 *               needsFix() で赤く示す。
 */
export function deriveLane(item: BoardItem): Lane {
  if (isArchived(item)) return "done";
  const run = item.latestRun;
  const stage = stageOf(item.featurePhase);
  if (!run && stage === "demo") return "queued";
  if (run && (run.status === "pending" || run.status === "running")) {
    return STAGE_LANES[stage].running;
  }
  return STAGE_LANES[stage].review;
}

/** Bucket every board item into its lane, preserving input (newest-first) order. */
export function groupByLane(items: BoardItem[]): Record<Lane, BoardItem[]> {
  const out = Object.fromEntries(LANES.map((l) => [l, [] as BoardItem[]])) as Record<
    Lane,
    BoardItem[]
  >;
  for (const item of items) out[deriveLane(item)].push(item);
  return out;
}
