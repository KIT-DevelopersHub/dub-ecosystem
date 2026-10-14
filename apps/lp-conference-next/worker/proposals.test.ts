// Run: node --test worker/proposals.test.ts (Node >= 22.18 strips TS types natively).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEMO_PROPOSAL_CONFIG,
  SPEAKER_CTA_SELECTOR,
  handleProposals,
  mapSubmitError,
  matchProposalsRoute,
  parseProposalConfig,
  parseProposalForm,
  previewProposals,
  proposalsInjection,
  renderProposalsPage,
  type ProposalConfig,
  type ProposalsDeps,
} from "./proposals.ts";
import { previewBar } from "./tickets.ts";
import { proposalsCookie, proposalsPreview, ticketsPreview } from "./route.ts";

const XSS = '<script>alert("x")</script>';
const CFG: ProposalConfig = { ...DEMO_PROPOSAL_CONFIG, enabled: true, preview: false };
const VALID = new URLSearchParams({
  title: "Workers の話",
  abstract: "全版同梱",
  name: "北陸 太郎",
  email: "taro@example.com",
  f_format: "LT（5分）",
});

function deps(over: Partial<ProposalsDeps> = {}, calls: { path: string; body: string }[] = []): ProposalsDeps {
  return {
    demo: false,
    getConfig: async () => CFG,
    internal: async (path, init) => {
      calls.push({ path, body: String(init.body) });
      return Response.json({ id: "lpp_1" }, { status: 201 });
    },
    ...over,
  };
}

const post = (body: URLSearchParams, headers: Record<string, string> = {}) =>
  new Request("https://lp.example/proposals/submit", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://lp.example", ...headers },
    body: body.toString(),
  });

test("matchProposalsRoute", () => {
  assert.equal(matchProposalsRoute("/proposals"), "page");
  assert.equal(matchProposalsRoute("/proposals/"), "page");
  assert.equal(matchProposalsRoute("/proposals/submit"), "submit");
  assert.equal(matchProposalsRoute("/proposals/thanks"), "thanks");
  assert.equal(matchProposalsRoute("/proposalsx"), null);
  assert.equal(matchProposalsRoute("/tickets"), null);
});

test("parseProposalConfig: drops malformed fields, rejects malformed payloads", () => {
  assert.equal(parseProposalConfig(null), null);
  assert.equal(parseProposalConfig({ enabled: "yes", fields: [] }), null);
  const c = parseProposalConfig({ enabled: true, fields: [{ id: "a", label: "A", type: "weird" }, { id: 1 }] });
  assert.deepEqual(c, { enabled: true, preview: false, fields: [{ id: "a", label: "A", type: "text", required: false, options: [] }] });
});

test("previewProposals: on shows a closed call as preview, off hides an open one", () => {
  const closed = { ...CFG, enabled: false };
  assert.deepEqual(previewProposals(closed, "on"), { ...closed, enabled: true, preview: true });
  assert.equal(previewProposals(CFG, "off")!.enabled, false);
  assert.equal(previewProposals(CFG, null), CFG);
  assert.equal(previewProposals(null, "on"), null);
});

test("parseProposalForm: fixed + configured fields, honeypot = spam", () => {
  const ok = parseProposalForm(VALID, CFG);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.input.answers, { format: "LT（5分）", affiliation: "", bio: "" });

  const bad = parseProposalForm(new URLSearchParams({ email: "x", f_format: "基調講演" }), CFG);
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.deepEqual(Object.keys(bad.errors).sort(), ["abstract", "email", "f_format", "name", "title"]);
    assert.equal(bad.spam, false);
  }
  const spam = parseProposalForm(new URLSearchParams({ ...Object.fromEntries(VALID), website: "x" }), CFG);
  assert.equal(!spam.ok && spam.spam, true);
});

test("renderProposalsPage escapes values and shows the configured fields", () => {
  const html = renderProposalsPage({ config: CFG, values: { title: XSS }, errors: { title: "x" } });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /登壇者<span class="g">募集<\/span>/);
  assert.match(html, /name="f_format"/);
  assert.match(html, /action="\/proposals\/submit"/);
  assert.doesNotMatch(html, /data-lp-tk-preview/);
  assert.match(renderProposalsPage({ config: { ...CFG, preview: true } }), /data-lp-tk-preview/);
});

test("handleProposals: closed / unavailable fall through to the 404 page", async () => {
  assert.equal(await handleProposals(new Request("https://lp.example/proposals"), deps({ getConfig: async () => null })), null);
  assert.equal(
    await handleProposals(new Request("https://lp.example/proposals"), deps({ getConfig: async () => ({ ...CFG, enabled: false }) })),
    null,
  );
  assert.equal(await handleProposals(new Request("https://lp.example/other"), deps()), null);
});

test("handleProposals: page has noindex + DENY framing", async () => {
  const res = (await handleProposals(new Request("https://lp.example/proposals"), deps()))!;
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-robots-tag"), "noindex");
  assert.match(await res.text(), /この内容で応募する/);
});

test("handleProposals: valid submit goes to lp-analytics then thanks", async () => {
  const calls: { path: string; body: string }[] = [];
  const res = (await handleProposals(post(VALID), deps({}, calls)))!;
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/proposals/thanks");
  assert.equal(calls[0]!.path, "/lp/internal/proposals/submit");
  assert.deepEqual(JSON.parse(calls[0]!.body).answers.format, "LT（5分）");
});

test("handleProposals: invalid form re-renders with 400 and never calls upstream", async () => {
  const calls: { path: string; body: string }[] = [];
  const res = (await handleProposals(post(new URLSearchParams({ title: "x" })), deps({}, calls)))!;
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
  assert.match(await res.text(), /氏名を入力してください/);
});

test("handleProposals: preview never submits (403)", async () => {
  const calls: { path: string; body: string }[] = [];
  const res = (await handleProposals(post(VALID), deps({ getConfig: async () => ({ ...CFG, preview: true }) }, calls)))!;
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
  assert.match(await res.text(), /プレビュー表示中のため/);
});

test("handleProposals: cross-origin POST is refused, GET submit redirects", async () => {
  assert.equal((await handleProposals(post(VALID, { origin: "https://evil.example" }), deps()))!.status, 403);
  const r = (await handleProposals(new Request("https://lp.example/proposals/submit"), deps()))!;
  assert.equal(r.status, 303);
});

test("handleProposals: demo goes straight to thanks without upstream", async () => {
  const calls: { path: string; body: string }[] = [];
  const res = (await handleProposals(post(VALID), deps({ demo: true }, calls)))!;
  assert.equal(res.status, 303);
  assert.equal(calls.length, 0);
});

test("handleProposals: upstream errors map to inline messages", async () => {
  const res = (await handleProposals(
    post(VALID),
    deps({ internal: async () => Response.json({ error: { code: "RATE_LIMITED" } }, { status: 429 }) }),
  ))!;
  assert.equal(res.status, 429);
  assert.match(await res.text(), /応募が集中しています/);
  const e = mapSubmitError(400, { error: { details: [{ field: "answers.format", reason: "invalid" }, { field: "title" }] } }, CFG);
  assert.equal(e.f_format, "入力内容を確認してください");
  assert.equal(e.title, "入力内容を確認してください");
});

test("proposalsInjection: speaker button swap only while open", () => {
  assert.equal(proposalsInjection(null), "");
  assert.equal(proposalsInjection({ ...CFG, enabled: false }), "");
  const html = proposalsInjection(CFG);
  assert.match(html, /lp-proposals-cta-swap/);
  assert.ok(html.includes(JSON.stringify(SPEAKER_CTA_SELECTOR)));
  assert.match(html, /"\/proposals"/);
});

test("previewBar lists every previewed feature in one bar", () => {
  assert.equal(previewBar([]), "");
  assert.match(previewBar(["チケット販売", "登壇者募集"]), /チケット販売・登壇者募集のプレビュー表示中です/);
});

test("proposalsPreview / proposalsCookie mirror the tickets preview, independently", () => {
  const u = new URL("https://lp.example/?version=3.5&proposals=on");
  assert.equal(proposalsPreview(u, null), "on");
  assert.equal(ticketsPreview(u, null), null);
  assert.match(proposalsCookie(u)!, /^lp_proposals=on;/);
  assert.equal(proposalsPreview(new URL("https://lp.example/x"), "lp_proposals=off"), "off");
  assert.equal(proposalsPreview(new URL("https://lp.example/_next/a.js"), null, "https://lp.example/?proposals=on"), "on");
  const live = new URL("https://lp.example/?version=live");
  assert.equal(proposalsPreview(live, "lp_proposals=on"), null);
  assert.match(proposalsCookie(live)!, /Max-Age=0/);
});
