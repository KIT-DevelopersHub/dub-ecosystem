// Run: node --test worker/lp-content.test.ts (Node >= 22.18 strips TS types natively).
import { test } from "node:test";
import assert from "node:assert/strict";
import { LP_SECTION_REGISTRY, type LpLayout } from "../../../packages/types/src/lp.ts";
import { siteConfigCss } from "../src/sections/slots.ts";
import {
  contentInjections,
  formatNewsDate,
  PARTNER_MARQUEE_MIN,
  renderNews,
  renderPartners,
  renderSpeakers,
  renderSponsors,
} from "./lp-content.ts";

const partner = (i: number) => ({ id: `p${i}`, name: `団体${i}`, logoUrl: `/p/${i}.png`, url: i % 2 ? "https://example.com" : "" });

test("formatNewsDate: 2026-11-22 → 2026/11/22(日)", () => {
  assert.equal(formatNewsDate("2026-11-22"), "2026/11/22(日)");
  assert.equal(formatNewsDate("2027-09-13"), "2027/09/13(月)");
});

test("everything is escaped; unsafe URLs are dropped", () => {
  const html = renderNews([{ id: "n", date: "2026-11-22", text: '<script>alert("x")</script>', url: "javascript:alert(1)", highlight: false }]);
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("javascript:"));
  const sp = renderSpeakers([{ id: "s", name: '"><img src=x onerror=1>', furigana: "", affiliation: "", photoUrl: "", message: "" }]);
  assert.ok(!sp.includes("<img src=x"));
});

test("news: highlighted rows get the mark; external links open in a new tab", () => {
  const html = renderNews([
    { id: "a", date: "2026-11-22", text: "チケット販売を開始しました。", url: "https://example.com/t", highlight: true },
    { id: "b", date: "2026-11-20", text: "あああ", url: "", highlight: false },
  ]);
  assert.match(html, /data-highlight="on".*lp-news-mark.*target="_blank"/s);
  assert.match(html, /data-highlight="off"><time class="lp-news-date" datetime="2026-11-20">2026\/11\/20\(金\)/);
});

test("partners: a centered row while few, a marquee (doubled, second copy hidden from AT) when many", () => {
  const few = renderPartners([1, 2, 3].map(partner));
  assert.match(few, /data-marquee="off"/);
  assert.equal((few.match(/class="lp-partner"/g) ?? []).length, 3);
  const many = renderPartners(Array.from({ length: PARTNER_MARQUEE_MIN }, (_, i) => partner(i)));
  assert.match(many, /data-marquee="on"/);
  assert.match(many, /aria-hidden="true"/);
  assert.equal((many.match(/class="lp-partner"/g) ?? []).length, PARTNER_MARQUEE_MIN * 2);
});

test("speakers: the message opens with <details>; no message → no toggle", () => {
  const html = renderSpeakers([
    { id: "a", name: "松本 絆那", furigana: "まつもと きずな", affiliation: "金沢工業大学工学部", photoUrl: "", message: "よろしく" },
    { id: "b", name: "山田", furigana: "", affiliation: "", photoUrl: "https://example.com/y.jpg", message: "" },
  ]);
  assert.equal((html.match(/<details/g) ?? []).length, 1);
  assert.equal((html.match(/lp-speaker-toggle/g) ?? []).length, 1);
  assert.match(html, /lp-speaker-initial[^>]*>松</);
});

test("sponsors: grouped Title → Bronze, empty tiers skipped, description only for Title", () => {
  const html = renderSponsors([
    { id: "b", tier: "bronze", name: "B社", logoUrl: "", url: "", description: "出ない" },
    { id: "t", tier: "title", name: "T社", logoUrl: "/t.png", url: "https://t.example", description: "出る" },
  ]);
  assert.ok(html.indexOf('data-tier="title"') < html.indexOf('data-tier="bronze"'));
  assert.ok(!html.includes('data-tier="gold"'));
  assert.ok(html.includes("出る"));
  assert.ok(!html.includes("出ない"));
});

test("contentInjections: public = visible sections only; preview = every section with items", () => {
  const layout: LpLayout = {
    schema: 1,
    sections: { news: { variant: "a", visible: true, options: {} } },
    content: {
      news: [{ id: "n", date: "2026-11-22", text: "x", url: "", highlight: false }],
      speakers: [{ id: "s", name: "y", furigana: "", affiliation: "", photoUrl: "", message: "" }],
    },
  };
  assert.deepEqual(Object.keys(contentInjections(layout, false)), ["news"]);
  assert.deepEqual(Object.keys(contentInjections(layout, true)), ["news", "speakers"]);
  assert.deepEqual(contentInjections(null, true), {});
});

test("siteConfigCss: default-hidden sections show only with their attribute", () => {
  const css = siteConfigCss(LP_SECTION_REGISTRY);
  assert.ok(css.includes('html:not([data-lp-s-news]) [data-lp-slot="news"]'));
  assert.ok(css.includes('html[data-lp-s-news="off"] [data-lp-slot="news"]'));
  // 既定で表示のセクションは今までどおり（属性が無ければ出る）。
  assert.ok(!css.includes('html:not([data-lp-s-join]) [data-lp-slot="join"]'));
});
