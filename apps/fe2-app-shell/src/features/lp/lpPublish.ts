// LP の「公開中の版」切り替えの純粋ロジック（URL 組み立て・表示用整形）。
//
// 公開版はリモートフラグ（GET/POST /api/v1/lp/publish）で、ビルドもデプロイもしない。
// 公開サイトは ?version=<番号> で任意の版をプレビューでき、?version=live でプレビューを解除して
// 公開中の版に戻る。

/** 公開 LP のベース URL。環境ごとに VITE_LP_PUBLIC_URL で差し替えられる。 */
export const LP_PUBLIC_URL: string = (
  (import.meta.env.VITE_LP_PUBLIC_URL as string | undefined) || "https://hokuriku-it-conf.com"
).replace(/\/+$/, "");

/** 切り替え成功の文言（demo の verify:live マーカーも兼ねる）。 */
export const PUBLISH_SUCCESS_MARKER = "公開中の版を切り替えました";

export function publishSuccessMessage(name: string): string {
  return `公開中の版を ${name} に切り替えました`;
}

/**
 * 「見る」の行き先。公開対象の版は公開サイトのプレビュー URL、公開中の版は ?version=live
 * （プレビュー cookie を解除して本番の見え方にする）。公開対象外の版は元の URL のまま。
 */
export function lpViewUrl(
  id: string,
  fallbackUrl: string,
  publish: { versionId: string; versions: readonly string[] } | undefined,
  base: string = LP_PUBLIC_URL,
): string {
  if (!publish || !publish.versions.includes(id)) return fallbackUrl;
  const v = id === publish.versionId ? "live" : id.replace(/^v/, "");
  return `${base}/?version=${encodeURIComponent(v)}`;
}

export type LpPreviewMode = "on" | "off";

/**
 * 「プレビュー」タブの行き先。版は公開中でも番号で指定する（live はプレビュー cookie を消すため）。
 * tickets: on = 販売停止中でも販売中の見た目（申し込み不可）/ off = 販売中でも出さない。
 * proposals: on = 募集停止中でも募集中の見た目（応募不可）/ off = 募集中でも出さない。
 * どれもこの閲覧者にだけ効き、公開中の LP は変わらない。
 */
export function lpPreviewUrl(
  id: string,
  modes: { tickets: LpPreviewMode; proposals: LpPreviewMode },
  base: string = LP_PUBLIC_URL,
): string {
  return `${base}/?version=${encodeURIComponent(id.replace(/^v/, ""))}&tickets=${modes.tickets}&proposals=${modes.proposals}`;
}

/** 切り替え日時の表示（"2026/10/12 14:05"）。壊れた値はそのまま返す。 */
export function formatSwitchedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ja-JP", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
