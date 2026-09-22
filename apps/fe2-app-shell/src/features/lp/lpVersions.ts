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
    id: "v3.1",
    name: "v3.1 ヒーロー立体強化版",
    description:
      "v3.0 のダイナミック刷新をベースに、ファーストビュー(ヒーロー)を全画面の WebGL 3D ブロブ場＋巨大発光タイポに強化。スクロールに合わせてカメラが立体的に潜り込む非線形の奥行き演出を追加し、フォント読み込みを非同期化して表示速度(Lighthouse)を改善、ヒーロー背景は見た目そのままに描画コストを大幅軽量化。本番ドメイン hokuriku-it-conf.com に反映済み。",
    url: "https://hokuriku-it-conf.com",
    updatedAt: "2026-09-22",
    status: "current",
  },
  {
    id: "v3.0",
    name: "v3.0 ダイナミック刷新版",
    description:
      "参考サイト goodpatch.com の見た目・動きに寄せて全面刷新した LP。GSAP + ScrollTrigger + Lenis による滑らかなスクロール演出、流れる大型英字マーキー、色ブロックのヒーロー、セクションのリビール表示を追加。v3.1 へ差し替え済みのため参照用アーカイブとして保存。",
    url: "https://lp-conference-next-v3-0.developershub-site.workers.dev",
    updatedAt: "2026-09-22",
    status: "archived",
  },
  {
    id: "v2.1",
    name: "v2.1 磨き上げ版",
    description:
      "v2.0 をさらに磨いた版。クラウドファンディングを CAMPFIRE の支援ページへ直接リンク、受付前の「参加登録」「登壇応募」を準備中表示に、本文の改行を整え、スクロール連動アニメーションを追加。v3.0 へ差し替え済みのため参照用アーカイブとして保存。",
    url: "https://lp-conference-next-v2-1.developershub-site.workers.dev",
    updatedAt: "2026-09-17",
    status: "archived",
  },
  {
    id: "v2.0",
    name: "v2.0 リニューアル版",
    description:
      "Next.js で作り直した磨き上げ版。Inter+Zen Kaku のタイポグラフィ、オリジナルのブランドグラデーション SVG、WCAG AA 準拠。v2.1 へ差し替え済みのため参照用アーカイブとして保存。",
    url: "https://lp-conference-next-v2.developershub-site.workers.dev",
    updatedAt: "2026-09-16",
    status: "archived",
  },
  {
    id: "v1.0",
    name: "v1.0 テキスト版",
    description: "北陸ITカンファレンスの初版 LP（テキスト中心）。v2.0 へ差し替え済みのため参照用アーカイブとして保存。",
    url: "https://lp-conference-v1.developershub-site.workers.dev",
    updatedAt: "2026-09-07",
    status: "archived",
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
