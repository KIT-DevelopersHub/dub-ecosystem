// Slack channel import — pure helpers + the browser-side job driver.
// chat-service runs a job only while a client POSTs …/step (bounded work per call, cursor
// persisted), so the open screen is the engine: driveSlackImport loops step until the job
// is done/failed, waiting out Slack rate limits (retryAfterMs). Reopening resumes.
import type { ChatApiClient } from "../api/client";
import type { SlackImportCounters, SlackImportJob, SlackImportPhase } from "../api/contract";

/** Liveness marker rendered by the import screen (deploy:demo / verify:live). */
export const SLACK_IMPORT_MARKER = "slack-import-v1";

// Same text as chat-service JOB_ERROR_MESSAGES — fallback when a job carries only a code.
export const JOB_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  not_in_channel: "LMB がこのチャンネルに参加していません。Slack で LMB を招待してから再開してください。",
  channel_not_found: "Slack チャンネルが見つかりません。非公開チャンネルは LMB を招待すると表示されます。",
  is_archived: "アーカイブ済みの公開チャンネルには LMB が参加できません。",
  invalid_auth: "Slack のトークンが無効です。管理者に SLACK_BOT_TOKEN の確認を依頼してください。",
  missing_scope: "Slack アプリの権限(スコープ)が不足しています。",
};

export function jobErrorText(error: { code: string; message?: string | null } | null): string | null {
  if (!error) return null;
  return error.message || JOB_ERROR_MESSAGES[error.code] || `Slack API エラー: ${error.code}`;
}

/** Stepper order. `done` is the terminal state, shown as the last step. */
export const IMPORT_PHASES: readonly { phase: SlackImportPhase; label: string }[] = [
  { phase: "users", label: "メンバー照合" },
  { phase: "channel", label: "チャンネル作成" },
  { phase: "history", label: "メッセージ" },
  { phase: "threads", label: "スレッド" },
  { phase: "files", label: "ファイル" },
  { phase: "finalize", label: "仕上げ" },
  { phase: "done", label: "完了" },
];

export function phaseIndex(phase: SlackImportPhase): number {
  return Math.max(0, IMPORT_PHASES.findIndex((p) => p.phase === phase));
}

export type StepState = "complete" | "current" | "failed" | "upcoming";

/** Per-step state for the stepper of one job. */
export function stepStates(job: Pick<SlackImportJob, "phase" | "status">): StepState[] {
  const at = phaseIndex(job.phase);
  return IMPORT_PHASES.map((_, i) => {
    if (job.status === "done" || i < at) return "complete";
    if (i === at) return job.status === "failed" ? "failed" : "current";
    return "upcoming";
  });
}

export const COUNTER_LABELS: readonly { key: keyof SlackImportCounters; label: string }[] = [
  { key: "messages", label: "メッセージ" },
  { key: "threadReplies", label: "スレッド返信" },
  { key: "reactions", label: "リアクション" },
  { key: "pins", label: "ピン" },
  { key: "files", label: "ファイル" },
  { key: "filesSkipped", label: "スキップ" },
];

export function isActiveJob(job: Pick<SlackImportJob, "status">): boolean {
  return job.status === "queued" || job.status === "running";
}

export const STATUS_LABEL: Record<SlackImportJob["status"], string> = {
  queued: "待機中",
  running: "取り込み中",
  done: "完了",
  failed: "失敗",
};

/** Normalize the "#general" / " general " a user types into the channel ref the API takes. */
export function normalizeSlackChannelRef(raw: string): string {
  return raw.trim().replace(/^#/, "").trim();
}

/** HTTP error -> the sentence the import screen shows (412 = not configured, etc.). */
export function describeImportError(e: unknown): string {
  const err = (e ?? {}) as { status?: number; code?: string; message?: string };
  switch (err.status) {
    case 412:
      return "Slack 連携がまだ設定されていません。管理者に SLACK_BOT_TOKEN の設定を依頼してください。";
    case 403:
      return "チャンネル取り込みの権限がありません。";
    case 404:
      return "Slack チャンネルが見つかりません。非公開チャンネルは LMB を招待すると選べるようになります。";
    case 429:
      return "Slack のレート制限中です。少し待ってからもう一度お試しください。";
    case 409:
      return err.message || "Slack 側でエラーが発生しました。";
    default:
      return "取り込みの通信に失敗しました。もう一度お試しください。";
  }
}

export function isNotConfigured(e: unknown): boolean {
  return (e as { status?: number } | null)?.status === 412;
}

// ---- driver ----

/** Minimum gap between steps so a fast server (or the demo mock) is not hammered. */
export const MIN_STEP_INTERVAL_MS = 400;
/** Back-off when a step made no progress (another tab holds the lease). */
export const IDLE_BACKOFF_MS = 2_000;

export interface DriveOptions {
  onUpdate: (job: SlackImportJob) => void;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms));

/**
 * Step `job` until it is done / failed or `signal` aborts. Rate-limit parks are waited
 * out client-side; network errors reject (the caller offers 再開). Returns the last job.
 */
export async function driveSlackImport(
  api: Pick<ChatApiClient, "stepSlackImport">,
  initial: SlackImportJob,
  { onUpdate, signal, sleep = defaultSleep }: DriveOptions,
): Promise<SlackImportJob> {
  let job = initial;
  let first = true;
  while (!signal?.aborted && isActiveJob(job)) {
    if (job.retryAfterMs > 0) await sleep(job.retryAfterMs);
    else if (!first) await sleep(MIN_STEP_INTERVAL_MS);
    first = false;
    if (signal?.aborted) break;
    const prev = job;
    job = await api.stepSlackImport(job.id);
    if (signal?.aborted) break;
    onUpdate(job);
    const stalled =
      isActiveJob(job) && job.retryAfterMs === 0 && job.phase === prev.phase && job.updatedAt === prev.updatedAt;
    if (stalled) await sleep(IDLE_BACKOFF_MS);
  }
  return job;
}
