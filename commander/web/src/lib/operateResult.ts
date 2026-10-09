// Text of the 【確認結果】/【実行結果】 messages the console persists into the session.
// They are what the planner reads back next turn ("過去の実行結果"), so they carry the
// facts in Japanese; read data samples sit after DATA_MARKER, which the UI folds away.

import type { ExecutionResult, Preview } from "./operateApi.ts";
import { RESULT_PREFIX } from "./operateDub.ts";

export const DATA_MARKER = "\n---読み取りデータ---\n";

const OUTCOME_LABEL = { ok: "反映済み", unverified: "未反映（読み直しで確認できず）", failed: "失敗", skipped: "対象外にした" } as const;

export function writeCount(preview: Preview): number {
  return preview.writes.reduce((n, w) => n + w.calls.length, 0);
}

export function formatPreviewNote(preview: Preview): string {
  const lines = [
    `${RESULT_PREFIX.preview}読み取り${preview.reads.length}件を実行（接続先: ${preview.environment}）。` +
      (preview.writes.length ? `書き込み予定 ${writeCount(preview)}件。` : "書き込みはありません。"),
    ...preview.reads.map((r) => `- ${r.description}: ${r.ok ? `${r.count ?? 1}件` : `失敗（${r.error}）`}`),
    ...preview.writes.map((w) => `- 予定: ${w.description} — ${w.calls.map((c) => c.target).join("、")}`),
    ...preview.blockers.map((b) => `- 実行できない理由: ${b}`),
  ];
  const data = preview.reads.filter((r) => r.sample).map((r) => `${r.stepId}: ${r.sample}`);
  return lines.join("\n") + (data.length ? DATA_MARKER + data.join("\n") : "");
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
