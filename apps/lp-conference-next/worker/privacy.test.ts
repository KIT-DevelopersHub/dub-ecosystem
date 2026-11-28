import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createPolicySource, FOOTER_LINK_TAG, handlePrivacy, isPrivacyPath, parsePolicyResponse, renderPrivacyPage } from "./privacy.ts";
import { LEGACY_VID_CLEANUP_TAG } from "./insights.ts";
import { DEFAULT_PRIVACY_POLICY } from "../../../packages/types/src/privacy-policy.ts";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

test("isPrivacyPath", () => {
  assert.equal(isPrivacyPath("/privacy"), true);
  assert.equal(isPrivacyPath("/privacy/"), true);
  assert.equal(isPrivacyPath("/privacy/x"), false);
  assert.equal(isPrivacyPath("/"), false);
});

test("parsePolicyResponse: saved / unset / malformed", () => {
  assert.deepEqual(parsePolicyResponse({ policy: { body: "本文", updatedAt: "2026-11-27T01:00:00Z" } }), { body: "本文", updatedAt: "2026-11-27T01:00:00Z" });
  assert.equal(parsePolicyResponse({ policy: null }), null);
  assert.equal(parsePolicyResponse({}), undefined);
  assert.equal(parsePolicyResponse({ policy: { body: " ", updatedAt: "x" } }), undefined);
  assert.equal(parsePolicyResponse(null), undefined);
});

test("policy source: reads via the internal route with the s2s marker, caches 60s", async () => {
  let t = 0;
  const calls: { url: string; internal: string | null }[] = [];
  let body: unknown = { policy: { body: "初版", updatedAt: "2026-11-27T01:00:00Z" } };
  const src = createPolicySource(async (url, init) => {
    calls.push({ url, internal: new Headers(init.headers).get("x-dub-internal") });
    return ok(body);
  }, () => t);
  assert.equal((await src()).body, "初版");
  body = { policy: { body: "改定", updatedAt: "2026-11-28T01:00:00Z" } };
  t = 59_000;
  assert.equal((await src()).body, "初版");
  t = 60_000;
  assert.deepEqual(await src(), { body: "改定", updatedAt: "2026-11-28T01:00:00Z" });
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0]!.url).pathname, "/members/internal/accounting/privacy-policy");
  assert.equal(calls[0]!.internal, "1");
});

test("policy source: unset → default draft; failure → last good, else default; no binding → default", async () => {
  let t = 0;
  let mode: "unset" | "saved" | "fail" = "unset";
  const src = createPolicySource(async () => {
    if (mode === "fail") throw new Error("down");
    return ok(mode === "unset" ? { policy: null } : { policy: { body: "保存済み", updatedAt: "2026-11-27T01:00:00Z" } });
  }, () => t);
  assert.deepEqual(await src(), { body: DEFAULT_PRIVACY_POLICY, updatedAt: null });
  mode = "saved";
  t += 60_000;
  assert.equal((await src()).body, "保存済み");
  mode = "fail";
  t += 60_000;
  assert.equal((await src()).body, "保存済み");

  const cold = createPolicySource(async () => new Response("no", { status: 503 }));
  assert.equal((await cold()).body, DEFAULT_PRIVACY_POLICY);
  assert.equal((await createPolicySource(null)()).body, DEFAULT_PRIVACY_POLICY);
});

test("page: escapes HTML in the body, shows the last-updated date in JST only when saved", () => {
  const html = renderPrivacyPage({ body: "## 1. 見出し\n\n<script>alert(1)</script>\n\n[外部](javascript:alert(1))", updatedAt: "2026-11-27T16:00:00Z" }, false);
  assert.match(html, /<h3>1\. 見出し<\/h3>/);
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!html.includes('href="javascript:'));
  assert.match(html, /最終更新日: 2026年11月28日/);
  assert.match(html, /<h1[^>]*>プライバシーポリシー<\/h1>/);

  const unset = renderPrivacyPage({ body: DEFAULT_PRIVACY_POLICY, updatedAt: null }, false);
  assert.ok(!unset.includes("最終更新日"));
  assert.ok(unset.includes("5. アクセス解析と外部送信"));
});

test("handlePrivacy: GET / HEAD only", async () => {
  const get = async () => ({ body: "本文", updatedAt: null });
  const res = await handlePrivacy(new Request("https://lp/privacy"), get, false);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.ok((await res.text()).includes("本文"));
  assert.equal((await handlePrivacy(new Request("https://lp/privacy", { method: "HEAD" }), get, false)).status, 200);
  assert.equal((await handlePrivacy(new Request("https://lp/privacy", { method: "POST" }), get, false)).status, 405);
});

test("legacy visitor id cleanup removes dub_lp_vid now and on pagehide", () => {
  const store = new Map<string, string>([["dub_lp_vid", "abc"], ["other", "x"]]);
  const handlers: Record<string, () => void> = {};
  const localStorage = { removeItem: (k: string) => store.delete(k) };
  const code = /<script[^>]*>([\s\S]*)<\/script>/.exec(LEGACY_VID_CLEANUP_TAG)![1]!;
  runInNewContext(code, { localStorage, addEventListener: (t: string, h: () => void) => (handlers[t] = h) });
  assert.equal(store.has("dub_lp_vid"), false);
  store.set("dub_lp_vid", "recreated");
  handlers.pagehide!();
  assert.equal(store.has("dub_lp_vid"), false);
  assert.equal(store.get("other"), "x");
});

test("footer link script adds one link after load, and re-adds it if the footer is re-rendered", () => {
  const children: { attrs: Record<string, string>; href?: string; textContent?: string }[] = [];
  const footer = {
    querySelector: (sel: string) => (sel === "[data-lp-privacy-link]" ? children.find((c) => "data-lp-privacy-link" in c.attrs) ?? null : null),
    appendChild: (el: { attrs: Record<string, string> }) => children.push(el as never),
  };
  let onLoad: (() => void) | null = null;
  let observer: (() => void) | null = null;
  const timers: (() => void)[] = [];
  const document = {
    readyState: "loading",
    body: {},
    querySelector: (sel: string) => (sel === ".footer-bottom-inner" ? footer : null),
    createElement: () => ({ attrs: {} as Record<string, string>, style: {}, setAttribute(k: string, v: string) { this.attrs[k] = v; } }),
  };
  const code = /<script[^>]*>([\s\S]*)<\/script>/.exec(FOOTER_LINK_TAG)![1]!;
  runInNewContext(code, {
    document,
    window: { MutationObserver: true },
    MutationObserver: class { constructor(cb: () => void) { observer = cb; } observe() {} disconnect() {} },
    addEventListener: (t: string, h: () => void) => { if (t === "load") onLoad = h; },
    setTimeout: (f: () => void) => timers.push(f),
  });
  assert.equal(children.length, 0, "nothing before load (no hydration mismatch)");
  onLoad!();
  timers.shift()!();
  assert.equal(children.length, 1);
  assert.equal(children[0]!.href, "/privacy");
  assert.equal(children[0]!.textContent, "プライバシーポリシー");
  observer!();
  assert.equal(children.length, 1, "idempotent");
  children.length = 0; // React re-rendered the footer
  observer!();
  assert.equal(children.length, 1);
});
