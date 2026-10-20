// Run: node --test worker/route.test.ts (Node >= 22.18 strips TS types natively).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isNavigation,
  normalizeVersion,
  previewBanner,
  previewQuery,
  proposalsPreview,
  readCookie,
  refererFallback,
  resolveRequest,
  rewriteLocation,
  staleCookieClears,
  ticketsPreview,
  withPreview,
} from "./route.ts";

const BUNDLED = ["v3.4", "v3.3", "v3.1"];
const ORIGIN = "https://lp.example";
const at = (path: string) => new URL(path, ORIGIN);
const hdrs = (h: Record<string, string>) => new Headers(h);

test("normalizeVersion accepts 3.1 / v3.1 and rejects unknown", () => {
  assert.equal(normalizeVersion("3.1", BUNDLED), "v3.1");
  assert.equal(normalizeVersion("V3.1", BUNDLED), "v3.1");
  assert.equal(normalizeVersion("9.9", BUNDLED), null);
  assert.equal(normalizeVersion(null, BUNDLED), null);
});

test("root without param serves published", () => {
  const r = resolveRequest(at("/"), "v3.4", BUNDLED);
  assert.deepEqual(r, { kind: "serve", version: "v3.4", preview: false, assetPath: "/versions/v3.4/" });
});

test("?version=3.1 serves v3.1 as preview (no cookie involved)", () => {
  const r = resolveRequest(at("/?version=3.1"), "v3.4", BUNDLED);
  assert.deepEqual(r, { kind: "serve", version: "v3.1", preview: true, assetPath: "/versions/v3.1/" });
});

test("unknown version param is ignored", () => {
  const r = resolveRequest(at("/?version=1.0"), "v3.4", BUNDLED);
  assert.equal(r.kind === "serve" && r.version, "v3.4");
});

test("?version=live redirects without any preview param", () => {
  const r = resolveRequest(at("/program/?version=live&tickets=on&proposals=off&utm_source=x"), "v3.4", BUNDLED);
  assert.deepEqual(r, { kind: "redirect", location: "/program/?utm_source=x" });
});

test("rewriteLocation maps internal asset redirects back to public paths", () => {
  const o = ORIGIN;
  assert.equal(rewriteLocation("/versions/v3.4/program/", "v3.4", o), "/program/");
  assert.equal(rewriteLocation("https://lp.example/versions/v3.4", "v3.4", o), "/");
  assert.equal(rewriteLocation("https://other.example/versions/v3.4/x", "v3.4", o), "https://other.example/versions/v3.4/x");
  assert.equal(rewriteLocation("/elsewhere/", "v3.4", o), "/elsewhere/");
});

test("readCookie finds the named cookie", () => {
  assert.equal(readCookie("x=1; lp_version=v3.3", "lp_version"), "v3.3");
  assert.equal(readCookie(null, "lp_version"), null);
});

test("legacy preview cookies are not an input: a plain visit is never a preview", () => {
  const r = resolveRequest(at("/"), "v3.4", BUNDLED, refererFallback(null, ORIGIN, true));
  assert.equal(r.kind === "serve" && r.preview, false);
  assert.equal(ticketsPreview(at("/tickets")), null);
  assert.equal(proposalsPreview(at("/proposals")), null);
});

test("staleCookieClears: Max-Age=0 for each legacy cookie the browser sent, nothing otherwise", () => {
  assert.deepEqual(staleCookieClears(null), []);
  assert.deepEqual(staleCookieClears("a=1; b=2"), []);
  assert.deepEqual(staleCookieClears("lp_version=v3.3; x=1; lp_tickets=on; lp_proposals=off"), [
    "lp_version=; Path=/; SameSite=None; Secure; HttpOnly; Max-Age=0",
    "lp_tickets=; Path=/; SameSite=None; Secure; HttpOnly; Max-Age=0",
    "lp_proposals=; Path=/; SameSite=None; Secure; HttpOnly; Max-Age=0",
  ]);
});

test("isNavigation: Sec-Fetch-Mode navigate / document|iframe dest; subresources and unknown are not", () => {
  assert.equal(isNavigation(hdrs({ "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" })), true);
  assert.equal(isNavigation(hdrs({ "sec-fetch-dest": "document" })), true);
  assert.equal(isNavigation(hdrs({ "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" })), false);
  assert.equal(isNavigation(hdrs({})), false);
});

test("referer fallback: same-origin subresources only, never a navigation", () => {
  const ref = "https://lp.example/?version=3.1&tickets=on";
  const sub = refererFallback(ref, ORIGIN, false);
  const r = resolveRequest(at("/logo.png"), "v3.4", BUNDLED, sub);
  assert.equal(r.kind === "serve" && r.version, "v3.1");
  assert.equal(ticketsPreview(at("/logo.png"), sub), "on");
  // A navigation from a preview page that lost its params = the normal page.
  const nav = refererFallback(ref, ORIGIN, true);
  assert.equal(nav, null);
  const n = resolveRequest(at("/program/"), "v3.4", BUNDLED, nav);
  assert.equal(n.kind === "serve" && n.version, "v3.4");
  assert.equal(ticketsPreview(at("/program/"), nav), null);
  // Other origins / garbage never count.
  assert.equal(refererFallback("https://evil.example/?version=3.1", ORIGIN, false), null);
  assert.equal(refererFallback("not a url", ORIGIN, false), null);
});

test("ticketsPreview: param (on/off only); live clears; public LP is null", () => {
  assert.equal(ticketsPreview(at("/")), null);
  assert.equal(ticketsPreview(at("/?version=3.4&tickets=on")), "on");
  assert.equal(ticketsPreview(at("/?tickets=OFF")), "off");
  assert.equal(ticketsPreview(at("/?tickets=yes")), null);
  assert.equal(ticketsPreview(at("/?version=live&tickets=on")), null);
});

test("proposalsPreview mirrors the tickets preview, independently", () => {
  const u = at("/?version=3.5&proposals=on");
  assert.equal(proposalsPreview(u), "on");
  assert.equal(ticketsPreview(u), null);
});

test("previewQuery keeps only valid preview params of the request", () => {
  assert.equal(previewQuery(at("/"), BUNDLED).toString(), "");
  assert.equal(previewQuery(at("/?utm_source=x&version=9.9&tickets=yes"), BUNDLED).toString(), "");
  assert.equal(
    previewQuery(at("/?version=3.1&tickets=ON&proposals=off&utm_source=x"), BUNDLED).toString(),
    "version=v3.1&tickets=on&proposals=off",
  );
});

test("withPreview carries params onto same-origin links / actions / Locations only", () => {
  const pq = new URLSearchParams("tickets=on&version=v3.1");
  assert.equal(withPreview("/tickets", ORIGIN, pq), "/tickets?tickets=on&version=v3.1");
  assert.equal(withPreview("/tickets/checkout", ORIGIN, pq), "/tickets/checkout?tickets=on&version=v3.1");
  assert.equal(withPreview("/?a=1#top", ORIGIN, pq), "/?a=1&tickets=on&version=v3.1#top");
  assert.equal(withPreview("https://lp.example/x", ORIGIN, pq), "https://lp.example/x?tickets=on&version=v3.1");
  // Explicit values win (e.g. a link that sets its own tickets=off).
  assert.equal(withPreview("/?tickets=off", ORIGIN, pq), "/?tickets=off&version=v3.1");
  for (const raw of [
    "#about",
    "https://checkout.stripe.com/c/pay/cs_test_1",
    "//evil.example/x",
    "mailto:a@b.example",
    "javascript:void(0)",
    "",
  ]) {
    assert.equal(withPreview(raw, ORIGIN, pq), raw);
  }
  assert.equal(withPreview("/tickets", ORIGIN, new URLSearchParams()), "/tickets");
});

test("preview banner 解除 goes to the bare URL and is exempt from link rewriting", () => {
  const html = previewBanner("v3.1", "v3.4");
  assert.match(html, /<a href="\/" data-lp-preview-exit /);
  assert.doesNotMatch(html, /version=live/);
});
