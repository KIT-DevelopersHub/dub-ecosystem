// Run: node --test worker/sponsors.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SPONSOR_CTA_SELECTOR,
  handleSponsors,
  isSponsorsPath,
  mapSponsorSubmitError,
  matchSponsorsRoute,
  parseSponsorConfig,
  parseSponsorForm,
  sponsorClientKeyFor,
  sponsorsInjection,
  type SponsorsDeps,
} from "./sponsors.ts";
import { HONEYPOT } from "./tickets.ts";

const VALID = "companyName=%E6%A0%AA%E5%BC%8F%E4%BC%9A%E7%A4%BE&contactName=&email=a%40example.com&message=";

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://lp.example/sponsors/submit", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body,
  });
}

function deps(over: Partial<SponsorsDeps> = {}, calls: { path: string; body: unknown }[] = [], status = 201): SponsorsDeps {
  return {
    demo: false,
    getConfig: async () => ({ enabled: true }),
    internal: async (path, init) => {
      calls.push({ path, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(status === 201 ? { id: "lps_1" } : { error: { details: [{ field: "email" }] } }), { status });
    },
    ...over,
  };
}

test("routes", () => {
  assert.equal(matchSponsorsRoute("/sponsors"), "page");
  assert.equal(matchSponsorsRoute("/sponsors/"), "page");
  assert.equal(matchSponsorsRoute("/sponsors/submit"), "submit");
  assert.equal(matchSponsorsRoute("/sponsors/thanks"), "thanks");
  assert.equal(matchSponsorsRoute("/sponsorsx"), null);
  assert.ok(isSponsorsPath("/sponsors/x"));
  assert.ok(!isSponsorsPath("/sponsor"));
});

test("config parsing", () => {
  assert.deepEqual(parseSponsorConfig({ enabled: true }), { enabled: true });
  assert.equal(parseSponsorConfig({ enabled: "yes" }), null);
  assert.equal(parseSponsorConfig(null), null);
});

test("closed / unavailable → null (normal 404)", async () => {
  const req = new Request("https://lp.example/sponsors");
  assert.equal(await handleSponsors(req, deps({ getConfig: async () => ({ enabled: false }) })), null);
  assert.equal(await handleSponsors(req, deps({ getConfig: async () => null })), null);
});

test("page shows the form: email required, others optional, honeypot present", async () => {
  const res = (await handleSponsors(new Request("https://lp.example/sponsors"), deps()))!;
  assert.equal(res.status, 200);
  const html = await res.text();
  for (const name of ["companyName", "contactName", "email", "message", HONEYPOT]) assert.ok(html.includes(`name="${name}"`), name);
  assert.match(html, /id="email"[^>]* required/);
  assert.doesNotMatch(html, /id="companyName"[^>]* required/);
});

test("only the email is required", () => {
  const missing = parseSponsorForm(new URLSearchParams("companyName=A"));
  assert.ok(!missing.ok && !missing.spam && missing.errors.email);
  const bad = parseSponsorForm(new URLSearchParams("email=nope"));
  assert.ok(!bad.ok && bad.errors.email === "メールアドレスの形式が正しくありません");
  const ok = parseSponsorForm(new URLSearchParams("email=a@example.com"));
  assert.ok(ok.ok);
});

test("submit forwards to lp-analytics with a hashed client key and redirects to thanks", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const res = (await handleSponsors(post(VALID, { "cf-connecting-ip": "203.0.113.7" }), deps({}, calls)))!;
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/sponsors/thanks");
  assert.equal(calls[0]!.path, "/lp/internal/sponsor-inquiries/submit");
  const sent = calls[0]!.body as Record<string, string>;
  assert.equal(sent.email, "a@example.com");
  assert.equal(sent.companyName, "株式会社");
  assert.match(sent.clientKey!, /^[a-f0-9]{32}$/);
  assert.equal(sent.clientKey, await sponsorClientKeyFor(new Request("https://x", { headers: { "cf-connecting-ip": "203.0.113.7" } })));
});

test("honeypot: looks successful, sends nothing", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const res = (await handleSponsors(post(`${VALID}&${HONEYPOT}=http://spam`), deps({}, calls)))!;
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/sponsors/thanks");
  assert.equal(calls.length, 0);
});

test("demo: thanks without calling the backend", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const res = (await handleSponsors(post(VALID), deps({ demo: true }, calls)))!;
  assert.equal(res.status, 303);
  assert.equal(calls.length, 0);
});

test("cross-origin posts are refused", async () => {
  const res = (await handleSponsors(post(VALID, { origin: "https://evil.example" }), deps()))!;
  assert.equal(res.status, 403);
});

test("backend errors are shown on the form (429 = too many)", async () => {
  const res = (await handleSponsors(post(VALID), deps({}, [], 429)))!;
  assert.equal(res.status, 429);
  assert.ok((await res.text()).includes("短い時間に多くの送信"));
  assert.equal(mapSponsorSubmitError(404, null)._form, "現在、スポンサーの募集は行っていません。");
  assert.equal(mapSponsorSubmitError(400, { error: { details: [{ field: "email" }] } }).email, "入力内容を確認してください");
});

test("LP injection swaps the sponsor card only while public", () => {
  assert.equal(sponsorsInjection(null), "");
  assert.equal(sponsorsInjection({ enabled: false }), "");
  const html = sponsorsInjection({ enabled: true });
  assert.ok(html.includes(JSON.stringify(SPONSOR_CTA_SELECTOR)));
  assert.ok(html.includes('"/sponsors"'));
});
