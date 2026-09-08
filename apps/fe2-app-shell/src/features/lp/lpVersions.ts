// LP管理 — バージョン定義（データ駆動の単一ソース）。
//
// 北陸ITカンファレンスのランディングページ(LP)を「バージョン」として一覧・閲覧するための
// 静的カタログ。今は現行 LP = v1.0 の 1 件だが、v2 以降を足すのは配列に 1 エントリ追加するだけ
// でよい（画面・ルート・権限には手を入れない）。将来サーバー配信に置き換えるときも、この
// モジュールの `listLpVersions()` を差し替えれば画面はそのまま動く（唯一の取得点）。
//
// v2 を追加する手順（1〜2 行）:
//   1. 下の LP_VERSIONS に { id, name, description, url, updatedAt, status } を 1 件足す。
//   2. （任意）status を "current" にし、旧版の status を "archived" に変える。

/** LP バージョンの公開状態。current = 現行運用中 / draft = 準備中 / archived = 旧版。 */
export type LpVersionStatus = "current" | "draft" | "archived";

export interface LpVersion {
  /** 安定 ID（並び順・キーに使用。作成後は変更しない）。 */
  id: string;
  /** 表示名（例: "v1.0 テキスト版"）。 */
  name: string;
  /** 一覧に出す 1 行説明。 */
  description: string;
  /** 「見る」リンク先の公開 URL。 */
  url: string;
  /** 最終更新日（ISO 8601, 例 "2026-09-07"）。 */
  updatedAt: string;
  /** 公開状態。 */
  status: LpVersionStatus;
}

/**
 * 北陸ITカンファレンス LP のバージョン一覧（新しい版を上に並べる想定で、表示側が
 * updatedAt 降順に整列する）。v1.0 = 現行のテキスト版 LP。
 */
export const LP_VERSIONS: readonly LpVersion[] = [
  {
    id: "v1.0",
    name: "v1.0 テキスト版",
    description: "北陸ITカンファレンスの現行 LP。テキスト中心の初版。",
    url: "https://lp-conference-next.developershub-site.workers.dev",
    updatedAt: "2026-09-07",
    status: "current",
  },
];

/**
 * バージョン一覧の取得点（唯一の入口）。今はローカルの静的カタログを Promise で返すだけ
 * だが、これを介すことで画面側は読み込み中(スケルトン)・空状態・エラーを一様に扱え、将来の
 * サーバー配信への差し替えも画面に波及しない。updatedAt 降順で返す。
 */
export function listLpVersions(): Promise<LpVersion[]> {
  const sorted = [...LP_VERSIONS].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return Promise.resolve(sorted);
}
