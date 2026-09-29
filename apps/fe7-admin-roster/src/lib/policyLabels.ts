// 表示用ラベル for the policy layer's 3 段階（無効 / 閲覧 / 編集）.
//
// 段階そのものと日本語ラベルは @dub/types policy が持つ（バックエンドの 403 文言と同じ
// 語彙を使うため）。ここはフロント固有の見せ方＝バッジの色（tone）と、段階の説明文への
// 薄いアクセサだけを足す。ラベルを二重管理しない（ズレ防止）。
import { policy } from "@dub/types";
import type { BadgeTone } from "@dub/ui";

export type Level = policy.AppAccessLevel;

/** 無効 / 閲覧 / 編集. */
export function levelLabel(level: Level): string {
  return policy.APP_ACCESS_LEVEL_LABELS[level];
}

/** 「このロールにとって何ができるか」の一文（表のキャプション・ダイアログの説明）. */
export function levelDescription(level: Level): string {
  return policy.APP_ACCESS_LEVEL_DESCRIPTIONS[level];
}

/**
 * バッジ色: 無効=neutral（灰）/ 閲覧=info（青＝見るだけ）/ 編集=success（緑＝書ける）。
 * 閲覧と編集を同じ緑にすると一覧で見分けられないので、閲覧は意図的に別トーンにする。
 */
export function levelTone(level: Level): BadgeTone {
  if (level === policy.AppAccessLevel.Edit) return "success";
  if (level === policy.AppAccessLevel.View) return "info";
  return "neutral";
}
