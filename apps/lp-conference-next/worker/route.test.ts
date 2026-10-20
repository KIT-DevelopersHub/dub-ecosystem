// Run: node --test worker/route.test.ts (Node >= 22.18 strips TS types natively).
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeVersion, readCookie, resolveRequest, rewriteLocation, ticketsCookie, ticketsPreview } from "./route.ts";

const BUNDLED = ["v3.4", "v3.3", "v3.1"];
const at = (path: string) => new URL(path, "https://lp.example");

test("normalizeVersion accepts 3.1 / v3.1 and rejects unknown", () => {
  assert.equal(normalizeVersion("3.1", BUNDLED), "v3.1");
  assert.equal(normalizeVersion("V3.1", BUNDLED), "v3.1");
  assert.equal(normalizeVersion("9.9", BUNDLED), null);
  assert.equal(normalizeVersion(null, BUNDLED), null);
});

test("root without param/cookie serves published", () => {
  const r = resolveRequest(at("/"), null, "v3.4", BUNDLED);
  assert.deepEqual(r, { kind: "serve", version: "v3.4", preview: false, assetPath: "/versions/v3.4/", setCookie: null });
});

test("?version=3.1 serves v3.1 as preview and sets session cookie", () => {
  const r = resolveRequest(at("/?version=3.1"), null, "v3.4", BUNDLED);
  assert.equal(r.kind, "serve");
  if (r.kind !== "serve") return;
  assert.equal(r.version, "v3.1");
  assert.equal(r.preview, true);
  assert.equal(r.setCookie, "lp_version=v3.1; Path=/; SameSite=None; Secure; HttpOnly");
});

test("cookie keeps the version for sub pages; param wins over cookie", () => {
  const r = resolveRequest(at("/program/"), "a=1; lp_version=v3.3", "v3.4", BUNDLED);
  assert.equal(r.kind === "serve" && r.assetPath, "/versions/v3.3/program/");
  const p = resolveRequest(at("/?version=v3.1"), "lp_version=v3.3", "v3.4", BUNDLED);
  assert.equal(p.kind === "serve" && p.version, "v3.1");
});

test("unknown version param is ignored without a cookie", () => {
  const r = resolveRequest(at("/?version=1.0"), null, "v3.4", BUNDLED);
  assert.equal(r.kind === "serve" && r.version, "v3.4");
  assert.equal(r.kind === "serve" && r.setCookie, null);
});

test("unbundled cookie value falls back to published", () => {
  const r = resolveRequest(at("/"), "lp_version=v0.1", "v3.4", BUNDLED);
  assert.equal(r.kind === "serve" && r.preview, false);
});

test("?version=live clears cookie and redirects without the param", () => {
  const r = resolveRequest(at("/program/?version=live&utm_source=x"), "lp_version=v3.1", "v3.4", BUNDLED);
  assert.equal(r.kind, "redirect");
  if (r.kind !== "redirect") return;
  assert.equal(r.location, "/program/?utm_source=x");
  assert.match(r.setCookie, /^lp_version=; .*Max-Age=0/);
});

test("rewriteLocation maps internal asset redirects back to public paths", () => {
  const o = "https://lp.example";
  assert.equal(rewriteLocation("/versions/v3.4/program/", "v3.4", o), "/program/");
  assert.equal(rewriteLocation("https://lp.example/versions/v3.4", "v3.4", o), "/");
  assert.equal(rewriteLocation("https://other.example/versions/v3.4/x", "v3.4", o), "https://other.example/versions/v3.4/x");
  assert.equal(rewriteLocation("/elsewhere/", "v3.4", o), "/elsewhere/");
});

test("readCookie finds the named cookie", () => {
  assert.equal(readCookie("x=1; lp_version=v3.3", "lp_version"), "v3.3");
  assert.equal(readCookie(null, "lp_version"), null);
});

test("same-origin referer with ?version= picks that version when no cookie (iframe)", () => {
  const r = resolveRequest(at("/logo.png"), null, "v3.4", BUNDLED, "https://lp.example/?version=3.1");
  assert.equal(r.kind === "serve" && r.version, "v3.1");
  const x = resolveRequest(at("/logo.png"), null, "v3.4", BUNDLED, "https://evil.example/?version=3.1");
  assert.equal(x.kind === "serve" && x.version, "v3.4");
});

test("ticketsPreview: param > cookie > same-origin referer; live clears; public LP is null", () => {
  assert.equal(ticketsPreview(at("/"), null), null);
  assert.equal(ticketsPreview(at("/?version=3.4&tickets=on"), null), "on");
  assert.equal(ticketsPreview(at("/?tickets=OFF"), "lp_tickets=on"), "off");
  assert.equal(ticketsPreview(at("/tickets"), "lp_tickets=on"), "on");
  assert.equal(ticketsPreview(at("/?tickets=yes"), null), null);
  assert.equal(ticketsPreview(at("/logo.png"), null, "https://lp.example/?tickets=on"), "on");
  assert.equal(ticketsPreview(at("/logo.png"), null, "https://evil.example/?tickets=on"), null);
  assert.equal(ticketsPreview(at("/?version=live"), "lp_tickets=on"), null);
});

test("ticketsCookie: 1 h cookie for ?tickets=, cleared by ?version=live", () => {
  assert.equal(ticketsCookie(at("/?tickets=on")), "lp_tickets=on; Path=/; SameSite=None; Secure; HttpOnly; Max-Age=3600");
  assert.match(ticketsCookie(at("/?version=live")) ?? "", /^lp_tickets=; .*Max-Age=0$/);
  assert.equal(ticketsCookie(at("/?version=3.4")), null);
});
