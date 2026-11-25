// 公開設定の中身（協力団体・お知らせ・登壇者・スポンサー）の編集ロジック。欄の定義は @dub/types の
// LP_CONTENT_FIELDS が唯一の正本（lp-analytics の検証・LP Worker の描画と同じもの）。UI はこれを汎用に描く。
import { lp } from "@dub/types";

export type ContentItem = lp.LpContentItem<lp.LpContentSectionId>;
/** フォームの下書き（欄の key → 値）。 */
export type ContentDraft = Record<string, string | boolean>;

/** 項目の ID（LP_CONTENT_ITEM_ID_RE に合う短い乱数）。 */
export function newContentItemId(): string {
  return `i_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function todayIso(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 新しい項目の下書き（お知らせは今日の日付・スポンサーは Gold から）。 */
export function emptyDraft(section: lp.LpContentSectionId, now = new Date()): ContentDraft {
  const out: ContentDraft = {};
  for (const f of lp.LP_CONTENT_FIELDS[section]) {
    out[f.key] =
      f.kind === "boolean" ? false : f.kind === "date" ? todayIso(now) : f.kind === "tier" ? "gold" : f.kind === "newsMode" ? lp.LP_NEWS_MODES[0] : "";
  }
  return out;
}

export function draftOf(section: lp.LpContentSectionId, item: ContentItem): ContentDraft {
  const rec = item as unknown as Record<string, string | boolean>;
  const out: ContentDraft = {};
  for (const f of lp.LP_CONTENT_FIELDS[section]) {
    out[f.key] = rec[f.key] ?? (f.kind === "boolean" ? false : f.kind === "newsMode" ? lp.LP_NEWS_MODES[0] : "");
  }
  return out;
}

export function contentErrorText(reason: string, field: lp.LpContentFieldDef): string {
  if (reason === "required") return `${field.label}を入力してください`;
  if (reason === "too_long") return `${field.max} 文字以内にしてください`;
  if (reason === "invalid_url") return "https:// から始まる URL か、/ から始まる LP 内のパスを入力してください";
  if (field.kind === "date") return "日付を選んでください";
  return "入力内容を確認してください";
}

/** 下書き → 項目（検証済み）か、欄ごとのエラー文。 */
export function draftToItem<S extends lp.LpContentSectionId>(
  section: S,
  id: string,
  draft: ContentDraft,
): { item: lp.LpContentItem<S> | null; errors: Record<string, string> } {
  const { item, issues } = lp.validateContentItem(section, { ...draft, id });
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.field.split(".").pop() ?? "";
    const field = lp.LP_CONTENT_FIELDS[section].find((f) => f.key === key);
    if (field && !errors[key]) errors[key] = contentErrorText(issue.reason, field);
  }
  return { item, errors };
}

/** 一覧の 1 行に出す見出し・補足・画像。 */
export function itemSummary(section: lp.LpContentSectionId, item: ContentItem): { title: string; sub: string; image: string | null } {
  switch (section) {
    case "partners": {
      const p = item as lp.LpPartnerItem;
      return { title: p.name, sub: p.url || "リンクなし", image: p.logoUrl || null };
    }
    case "news": {
      const n = item as lp.LpNewsItem;
      const action = n.mode === "dialog" ? "・ダイアログで詳細" : n.url ? "・リンクあり" : "";
      return { title: n.text, sub: `${n.date.replace(/-/g, "/")}${n.highlight ? "・強調" : ""}${action}`, image: null };
    }
    case "speakers": {
      const s = item as lp.LpSpeakerItem;
      return { title: s.name, sub: [s.furigana, s.affiliation].filter(Boolean).join("・") || "所属なし", image: s.photoUrl || null };
    }
    case "sponsors": {
      const s = item as lp.LpSponsorItem;
      return { title: s.name, sub: `${lp.LP_SPONSOR_TIER_LABELS[s.tier]}${s.url ? "・リンクあり" : ""}`, image: s.logoUrl || null };
    }
  }
}

/** スポンサーはプランの順（Title → Bronze）に並べたうえで、同じプランの中は今の並びを保つ。 */
export function sortSponsors(items: readonly lp.LpSponsorItem[]): lp.LpSponsorItem[] {
  return lp.LP_SPONSOR_TIERS.flatMap((t) => items.filter((s) => s.tier === t));
}

export function moveContent<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list.slice();
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}
