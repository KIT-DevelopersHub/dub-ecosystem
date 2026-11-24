// 公開設定の中身（協力団体・お知らせ・登壇者・スポンサー）を HTML にする（worker/index.ts から使う）。
// LP のビルド（SSG）は各セクションの枠と空の [data-lp-content="<id>"] だけを持ち、項目は Worker が
// HTMLRewriter で差し込む。見た目は globals.css（.lp-partners / .lp-news / .lp-speakers / .lp-sponsors）。
// 値は lp-analytics で検証済み（LP_CONTENT_FIELDS）だが、ここでも全部エスケープし URL は検め直す。
// No runtime-only imports so it runs under both workerd and `node --test` (strip-only TS).
import {
  isLpContentUrl,
  LP_CONTENT_SECTION_IDS,
  LP_SPONSOR_TIER_LABELS,
  LP_SPONSOR_TIERS,
  resolveContent,
  resolveSection,
  type LpContentSectionId,
  type LpLayout,
  type LpNewsItem,
  type LpPartnerItem,
  type LpSpeakerItem,
  type LpSponsorItem,
} from "../../../packages/types/src/lp.ts";
import { renderLpMarkdown, toEmbeddableImageUrl } from "../../../packages/types/src/lp-markdown.ts";
import { escapeHtml as e } from "./html.ts";

/** これ以上の協力団体はロゴを流す（マーキー）。少ないうちは中央に並べる。 */
export const PARTNER_MARQUEE_MIN = 8;

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** 2026-11-22 → 2026/11/22(日) */
export function formatNewsDate(date: string): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return date;
  return `${date.replace(/-/g, "/")}(${WEEKDAYS[new Date(t).getUTCDay()]})`;
}

const safeUrl = (u: string): string | null => (u && isLpContentUrl(u) ? u : null);
const external = (u: string): string => (/^https?:\/\//.test(u) ? ' target="_blank" rel="noopener noreferrer"' : "");
// Google ドライブの共有リンクはここで画像の URL に直す（保存は入力のまま）。
const img = (src: string | null, alt: string, cls: string): string =>
  src
    ? `<img class="${cls}" src="${e(toEmbeddableImageUrl(src))}" alt="${e(alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
    : "";

function partnerItems(items: readonly LpPartnerItem[], copy: boolean): string {
  return items
    .map((p) => {
      const logo = img(safeUrl(p.logoUrl), copy ? "" : p.name, "lp-partner-logo");
      const url = safeUrl(p.url);
      const inner = url
        ? `<a class="lp-partner-link" href="${e(url)}"${external(url)} title="${e(p.name)}"${copy ? ' tabindex="-1"' : ""}>${logo}</a>`
        : `<span class="lp-partner-link" title="${e(p.name)}">${logo}</span>`;
      return `<li class="lp-partner">${inner}</li>`;
    })
    .join("");
}

export function renderPartners(items: readonly LpPartnerItem[]): string {
  if (items.length === 0) return "";
  const marquee = items.length >= PARTNER_MARQUEE_MIN;
  // マーキーは同じ並びを 2 回描いて -50% ずらし続ける（2 回目は読み上げ・Tab の対象外）。
  const copy = marquee ? `<ul class="lp-partners-track" aria-hidden="true">${partnerItems(items, true)}</ul>` : "";
  return (
    `<div class="lp-partners-viewport" data-marquee="${marquee ? "on" : "off"}">` +
    `<ul class="lp-partners-track">${partnerItems(items, false)}</ul>${copy}</div>`
  );
}

/** お知らせ 1 行の本文: link = リンク（外部は新しいタブ）/ dialog = ダイアログを開くボタン + 詳細の <template>。 */
function newsText(n: LpNewsItem): string {
  if (n.mode === "dialog" && n.body.trim()) {
    // 詳細は <template> に入れておき、LP の NewsDialog（クライアント）が開くときに複製して出す。
    // 中身は renderLpMarkdown が作った安全な HTML（入力は全部エスケープ・決まったタグだけ・http(s) のみ）。
    return (
      `<button type="button" class="lp-news-link lp-news-open" data-news-open="${e(n.id)}" aria-haspopup="dialog">${e(n.text)}</button>` +
      `<template data-news-body="${e(n.id)}">${renderLpMarkdown(n.body)}</template>`
    );
  }
  const url = n.mode === "dialog" ? null : safeUrl(n.url);
  return url ? `<a class="lp-news-link" href="${e(url)}"${external(url)}>${e(n.text)}</a>` : `<span>${e(n.text)}</span>`;
}

export function renderNews(items: readonly LpNewsItem[]): string {
  if (items.length === 0) return "";
  const rows = items
    .map((n) => {
      const text = newsText(n);
      return (
        `<li class="lp-news-item" data-highlight="${n.highlight ? "on" : "off"}">` +
        `<time class="lp-news-date" datetime="${e(n.date)}">${e(formatNewsDate(n.date))}</time>` +
        `<p class="lp-news-text">${n.highlight ? '<span class="lp-news-mark" aria-hidden="true"></span>' : ""}${text}</p></li>`
      );
    })
    .join("");
  return `<ol class="lp-news-list">${rows}</ol>`;
}

function speakerHead(s: LpSpeakerItem, toggle: boolean): string {
  const photo = safeUrl(s.photoUrl);
  const initial = Array.from(s.name.trim())[0] ?? "";
  return (
    `<span class="lp-speaker-photo">${photo ? img(photo, s.name, "lp-speaker-img") : `<span class="lp-speaker-initial" aria-hidden="true">${e(initial)}</span>`}</span>` +
    `<span class="lp-speaker-info">` +
    `<span class="lp-speaker-name">${e(s.name)}</span>` +
    (s.furigana ? `<span class="lp-speaker-kana">${e(s.furigana)}</span>` : "") +
    (s.affiliation ? `<span class="lp-speaker-aff">${e(s.affiliation)}</span>` : "") +
    `</span>` +
    (toggle ? '<span class="lp-speaker-toggle" aria-hidden="true"></span>' : "")
  );
}

export function renderSpeakers(items: readonly LpSpeakerItem[]): string {
  if (items.length === 0) return "";
  const cards = items
    .map((s) => {
      // メッセージは <details> で開く（JS なし・キーボードでも開ける）。
      const body = s.message
        ? `<details class="lp-speaker-card"><summary class="lp-speaker-head" aria-label="${e(`${s.name}さんのメッセージを開く`)}">${speakerHead(s, true)}</summary>` +
          `<div class="lp-speaker-msg"><p class="lp-speaker-msg-title">メッセージ</p><p class="lp-speaker-msg-body">${e(s.message)}</p></div></details>`
        : `<div class="lp-speaker-card"><div class="lp-speaker-head">${speakerHead(s, false)}</div></div>`;
      return `<li class="lp-speaker">${body}</li>`;
    })
    .join("");
  return `<ul class="lp-speakers-grid">${cards}</ul>`;
}

function sponsorCard(s: LpSponsorItem): string {
  const logo = safeUrl(s.logoUrl);
  const url = safeUrl(s.url);
  const inner =
    `<span class="lp-sponsor-logo">${logo ? img(logo, s.name, "lp-sponsor-img") : `<span class="lp-sponsor-noimg" aria-hidden="true">${e(s.name)}</span>`}</span>` +
    `<span class="lp-sponsor-name">${e(s.name)}</span>` +
    (s.tier === "title" && s.description ? `<span class="lp-sponsor-desc">${e(s.description)}</span>` : "");
  return `<li class="lp-sponsor">${url ? `<a class="lp-sponsor-card" href="${e(url)}"${external(url)}>${inner}</a>` : `<div class="lp-sponsor-card">${inner}</div>`}</li>`;
}

export function renderSponsors(items: readonly LpSponsorItem[]): string {
  return LP_SPONSOR_TIERS.map((tier) => {
    const list = items.filter((s) => s.tier === tier);
    if (list.length === 0) return "";
    const label = LP_SPONSOR_TIER_LABELS[tier];
    return (
      `<div class="lp-sponsor-tier" data-tier="${tier}">` +
      `<h3 class="lp-sponsor-tier-head"><span class="lp-sponsor-tier-ghost" aria-hidden="true">${label}</span>` +
      `<span class="lp-sponsor-tier-label">${label}</span></h3>` +
      `<ul class="lp-sponsor-grid">${list.map(sponsorCard).join("")}</ul></div>`
    );
  }).join("");
}

const RENDER: { [S in LpContentSectionId]: (layout: LpLayout) => string } = {
  partners: (l) => renderPartners(resolveContent(l).partners),
  news: (l) => renderNews(resolveContent(l).news),
  speakers: (l) => renderSpeakers(resolveContent(l).speakers),
  sponsors: (l) => renderSponsors(resolveContent(l).sponsors),
};

/** [data-lp-content] の CSS セレクター。 */
export const contentSelector = (id: LpContentSectionId): string => `[data-lp-content="${id}"]`;

/**
 * 差し込む HTML（セクション → HTML・空のものは含めない）。
 * 公開表示は「表示」のセクションだけ（準備中の項目を HTML に載せない）。プレビュー（下書き）は全部載せて、
 * LP管理で表示を切り替えた瞬間（lp:config）にも中身が見えるようにする。
 */
export function contentInjections(layout: LpLayout | null, preview: boolean): Partial<Record<LpContentSectionId, string>> {
  const out: Partial<Record<LpContentSectionId, string>> = {};
  if (!layout) return out;
  for (const id of LP_CONTENT_SECTION_IDS) {
    if (!preview && !resolveSection(layout, id).visible) continue;
    const html = RENDER[id](layout);
    if (html) out[id] = html;
  }
  return out;
}
