import assert from "node:assert/strict";
import { test } from "node:test";
import { renderShareDialog, shareText, shareUrl, xShareHref } from "./share.ts";

const opts = { key: "tickets", origin: "https://hokuriku-it-conf.com", heading: "見出し", message: "参加します！" } as const;

test("shareUrl: 流入元つきの LP トップ", () => {
  assert.equal(shareUrl("https://example.com", "share-x"), "https://example.com/?utm_source=share-x");
});

test("xShareHref: ハッシュタグ入りの文面と URL が X の投稿画面に渡る", () => {
  const href = new URL(xShareHref(shareText("参加します！"), "https://example.com/?utm_source=share-x"));
  assert.equal(href.origin + href.pathname, "https://x.com/intent/post");
  assert.equal(href.searchParams.get("text"), "参加します！\n#北陸ITカンファレンス");
  assert.equal(href.searchParams.get("url"), "https://example.com/?utm_source=share-x");
});

test("renderShareDialog: X と Instagram の導線とハッシュタグを含む", () => {
  const html = renderShareDialog(opts);
  assert.ok(html.includes("<dialog"));
  assert.ok(html.includes("https://x.com/intent/post"));
  assert.ok(html.includes("https://www.instagram.com/"));
  assert.ok(html.includes("#北陸ITカンファレンス"));
});

test("renderShareDialog: origin / 文面はエスケープされる", () => {
  const html = renderShareDialog({ ...opts, origin: 'https://a"><script>x', message: "<img>" });
  assert.ok(!html.includes('"><script>x'));
  assert.ok(!html.includes("<img>"));
});
