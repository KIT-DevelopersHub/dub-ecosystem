// 流入URL（計測つきLP URL）の純粋ロジック。URL の組み立て・パラメータ値の正規化・入力検証を
// UI から切り離して単体テストする。
//
// 方針:
//  - 発行する URL は「LP の URL + クエリパラメータ 1 個」。独自の短縮/中継を挟まないので、
//    踏んだ人はワンホップで LP に着く（中継 Worker が落ちたら全導線が死ぬ構成を避ける）。
//  - パラメータ名は業界標準の utm_source。LP に GA 等を後から足しても同じ値で突き合わせられる。
//  - パラメータ値は必ず小文字に正規化する。Instagram と instagram が別集計になると
//    「同じ流入元なのに2行に割れる」事故になるため。

/** 現行の公開 LP（lpVersions.ts の status:"current" と同じ URL）。 */
export const LP_BASE_URL = "https://hokuriku-it-conf.com";

/** 流入元を載せるクエリパラメータ名。 */
export const LP_TRACKING_PARAM = "utm_source";

/** パラメータ値の最大長。URL が読めない長さになるのを防ぐ。 */
export const LP_SLUG_MAX = 32;
/** 表示名の最大長。 */
export const LP_NAME_MAX = 40;

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * 表示名 → パラメータ値の下書き。英数字以外は "-" に畳み、小文字へ。
 * 日本語だけの名前は空文字になる（＝呼び出し側に手入力させる。勝手に romaji 変換しない）。
 */
export function slugifySource(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, LP_SLUG_MAX);
}

/** 入力されたパラメータ値の正規化（小文字化 + 前後の空白と "-" の除去）。 */
export function normalizeSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^-+|-+$/g, "")
    .slice(0, LP_SLUG_MAX);
}

/** 流入URL を組み立てる。既存のクエリは保持し、同名パラメータは上書きする。 */
export function buildTrackingUrl(slug: string, baseUrl: string = LP_BASE_URL): string {
  const url = new URL(baseUrl);
  url.searchParams.set(LP_TRACKING_PARAM, slug);
  return url.toString();
}

export interface LpLinkDraft {
  name: string;
  slug: string;
}

/** フィールド単位のエラー文（日本語）。null のフィールドは問題なし。 */
export interface LpLinkDraftErrors {
  name: string | null;
  slug: string | null;
}

export const NO_DRAFT_ERRORS: LpLinkDraftErrors = { name: null, slug: null };

export function hasDraftError(errors: LpLinkDraftErrors): boolean {
  return errors.name !== null || errors.slug !== null;
}

/**
 * 発行フォームの検証。重複は「既存のパラメータ値一覧」を渡して呼び出し側で判定させる
 * （サーバーが最終判定だが、押す前に気づける方が親切）。
 */
export function validateLinkDraft(draft: LpLinkDraft, existingSlugs: readonly string[]): LpLinkDraftErrors {
  const name = draft.name.trim();
  const slug = normalizeSlug(draft.slug);

  let nameError: string | null = null;
  if (name.length === 0) nameError = "名前を入力してください（例: Instagram 告知投稿）";
  else if (name.length > LP_NAME_MAX) nameError = `名前は${LP_NAME_MAX}文字以内で入力してください`;

  let slugError: string | null = null;
  if (slug.length === 0) {
    slugError = "パラメータ値を半角英数字で入力してください（例: instagram）";
  } else if (!SLUG_RE.test(slug)) {
    slugError = "パラメータ値は半角英数字・ハイフン・アンダースコアのみ、先頭は英数字にしてください";
  } else if (existingSlugs.some((s) => s.toLowerCase() === slug)) {
    slugError = `「${slug}」は既に発行済みです。別の値を入れてください`;
  }

  return { name: nameError, slug: slugError };
}

/** 最終訪問の表示。null は「まだなし」（空欄にして欠損と混同させない）。 */
export function formatLastVisit(iso: string | null): string {
  if (!iso) return "まだなし";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}
