// Text of the 【確認結果】/【実行結果】 messages the console persists into the session.
// They are what the planner reads back next turn ("過去の実行結果"), so they carry the
// facts in Japanese; the read tables (every row, compacted by the daemon) sit after
// DATA_MARKER, which the UI folds away.

import type { ExecutionResult, Preview } from "./operateApi.ts";
import { DATA_MARKER, RESULT_PREFIX } from "./operateDub.ts";

export { DATA_MARKER };

const OUTCOME_LABEL = { ok: "反映済み", accepted: "受付済み（検証不能）", unverified: "未反映（読み直しで確認できず）", failed: "失敗", skipped: "対象外にした" } as const;

/** "5.1 KB" — sizes shown to the operator and the planner. */
export const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

export function writeCount(preview: Preview): number {
  return preview.writes.reduce((n, w) => n + w.calls.length, 0);
}

/** The compacted tables of every read, one section per step (what the answerer reads). */
export function readData(preview: Preview): string {
  return preview.reads
    .filter((r) => r.table)
    .map((r) => `## ${r.stepId}: ${r.description}（${r.rows ?? r.count ?? 0}行）\n${r.table}`)
    .join("\n\n");
}

/** `withData: false` = the tables were over budget and not handed on: keep only the facts. */
export function formatPreviewNote(preview: Preview, opts: { withData?: boolean } = {}): string {
  const lines = [
    `${RESULT_PREFIX.preview}読み取り${preview.reads.length}件を実行（接続先: ${preview.environment}）。` +
      (preview.writes.length ? `書き込み予定 ${writeCount(preview)}件。` : "書き込みはありません。"),
    ...preview.reads.map((r) => `- ${r.description}: ${r.ok ? `${r.rows ?? r.count ?? 1}行（約${kb(r.bytes ?? 0)}）` : `失敗（${r.error}）`}`),
    ...preview.writes.map((w) => `- 予定: ${w.description} — ${w.calls.map((c) => c.target).join("、")}`),
    ...preview.blockers.map((b) => `- 実行できない理由: ${b}`),
  ];
  const data = opts.withData === false ? "" : readData(preview);
  return lines.join("\n") + (data ? DATA_MARKER + data : "");
}

export function formatExecutionNote(result: ExecutionResult): string {
  return [
    `${RESULT_PREFIX.execution}${result.headline}`,
    ...result.results.map((r) => `- ${r.target}: ${OUTCOME_LABEL[r.outcome]}（${r.message}）`),
  ].join("\n");
}

export const CANCEL_NOTE = `${RESULT_PREFIX.execution}実行をやめました。何も変更していません`;

/** Split a persisted note into the visible part and the folded read data. */
export function splitNote(text: string): { visible: string; data: string } {
  const i = text.indexOf(DATA_MARKER);
  return i < 0 ? { visible: text, data: "" } : { visible: text.slice(0, i), data: text.slice(i + DATA_MARKER.length) };
}
