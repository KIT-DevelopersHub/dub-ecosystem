// Run: node --test worker/tickets.test.ts (Node >= 22.18 strips TS types natively).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEMO_CONFIG,
  escapeHtml,
  formatPrice,
  handleTickets,
  mapCheckoutError,
  matchTicketsRoute,
  parseCheckoutForm,
  parseConfig,
  renderThanksPage,
  renderTicketsPage,
  ticketsCta,
  type TicketConfig,
  type TicketsDeps,
} from "./tickets.ts";

const XSS = '<script>alert("x")</script>';
const CFG: TicketConfig = {
  enabled: true,
  paymentReady: true,
  fields: [
    { id: "org", label: "所属", type: "text", required: false, options: [] },
    { id: "mode", label: "参加区分", type: "select", required: true, options: ["現地", "オンライン"] },
    { id: "agree", label: "規約に同意", type: "checkbox", required: true, options: [] },
  ],
  types: [
    { id: "general", name: "一般", description: "", priceJpy: 3000, soldOut: false },
    { id: "free", name: "招待", description: "", priceJpy: 0, soldOut: false },
    { id: "gone", name: "早割", description: "", priceJpy: 2000, soldOut: true },
  ],
};
const form = (o: Record<string, string>) => new URLSearchParams(o);
const VALID = { ticketType: "general", name: "山田 太郎", email: "taro@example.com", f_mode: "現地", f_agree: "はい" };

function deps(over: Partial<TicketsDeps> = {}): TicketsDeps & { calls: { path: string; init: RequestInit }[] } {
  const calls: { path: string; init: RequestInit }[] = [];
  return {
    demo: false,
    getConfig: async () => CFG,
    invalidate: () => {},
    internal: async (path, init) => {
      calls.push({ path, init });
      return Response.json({ redirectUrl: "https://checkout.stripe.com/c/pay/cs_1" });
    },
    calls,
    ...over,
  };
}
const post = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request(`https://lp.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body).toString(),
  });

test("escapeHtml escapes all specials", () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
});

test("formatPrice", () => {
  assert.equal(formatPrice(3000), "¥3,000");
  assert.equal(formatPrice(1234567), "¥1,234,567");
  assert.equal(formatPrice(0), "無料");
});

test("matchTicketsRoute accepts trailing slash and rejects others", () => {
  assert.equal(matchTicketsRoute("/tickets"), "page");
  assert.equal(matchTicketsRoute("/tickets/"), "page");
  assert.equal(matchTicketsRoute("/tickets/thanks/"), "thanks");
  assert.equal(matchTicketsRoute("/tickets/checkout"), "checkout");
  assert.equal(matchTicketsRoute("/tickets/stripe-webhook"), "webhook");
  assert.equal(matchTicketsRoute("/ticketsx"), null);
  assert.equal(matchTicketsRoute("/"), null);
});

test("render escapes every dynamic text", () => {
  const cfg: TicketConfig = {
    ...CFG,
    fields: [{ id: "q", label: XSS, type: "select", required: false, options: [XSS] }],
    types: [{ id: XSS, name: XSS, description: XSS, priceJpy: 100, soldOut: false }],
  };
  const html = renderTicketsPage({ config: cfg, values: { name: XSS, f_q: XSS }, errors: { _form: XSS, name: XSS } });
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!renderThanksPage({ status: "paid", ticketTypeName: XSS }).includes("<script>alert"));
});

test("render: sold out / payment not ready / 受付準備中", () => {
  const html = renderTicketsPage({ config: CFG });
  assert.match(html, /売り切れ/);
  assert.match(html, /value="gone" disabled/);
  assert.match(html, /value="general" checked/);
  assert.match(html, /購入手続きへ/);
  const notReady = renderTicketsPage({ config: { ...CFG, paymentReady: false } });
  assert.match(notReady, /決済準備中/);
  assert.match(notReady, /value="general" disabled/);
  assert.match(notReady, /value="free" checked/);
  const none = renderTicketsPage({ config: { ...CFG, paymentReady: false, types: [CFG.types[0]] } });
  assert.match(none, /受付準備中/);
  assert.ok(!none.includes("<form"));
  assert.match(renderTicketsPage({ config: CFG, canceled: true }), /お支払いはキャンセルされました/);
  assert.match(renderTicketsPage({ config: CFG, demo: true }), /デモ環境です（実際の決済は行われません）/);
});

test("parseCheckoutForm: valid input", () => {
  const r = parseCheckoutForm(form({ ...VALID, f_org: "  KIT " }), CFG);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.input, {
    ticketTypeId: "general",
    name: "山田 太郎",
    email: "taro@example.com",
    answers: { org: "KIT", mode: "現地", agree: "はい" },
  });
});

test("parseCheckoutForm: errors keep values", () => {
  const r = parseCheckoutForm(form({ ticketType: "gone", name: "", email: "bad", f_mode: "宇宙", f_org: "x" }), CFG);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.spam, false);
  assert.deepEqual(Object.keys(r.errors).sort(), ["email", "f_agree", "f_mode", "name", "ticketType"]);
  assert.equal(r.values.f_org, "x");
  assert.equal(r.values.email, "bad");
  const html = renderTicketsPage({ config: CFG, values: r.values, errors: r.errors });
  assert.match(html, /value="bad"/);
  assert.match(html, /メールアドレスの形式が正しくありません/);
});

test("parseCheckoutForm: paid type rejected when payment not ready; honeypot = spam", () => {
  const r = parseCheckoutForm(form(VALID), { ...CFG, paymentReady: false });
  assert.equal(!r.ok && r.errors.ticketType, "この券種は現在お申し込みいただけません");
  const s = parseCheckoutForm(form({ ...VALID, website: "http://spam" }), CFG);
  assert.equal(!s.ok && s.spam, true);
});

test("mapCheckoutError maps 400 details and statuses", () => {
  // Same shape lp-analytics' dubErrorHandler emits: { error: { code, message, details } }.
  const wire = {
    error: {
      code: "VALIDATION_FAILED",
      message: "Validation failed",
      details: [{ field: "email", reason: "x" }, { field: "answers.mode", reason: "y" }, { field: "ticketTypeId" }],
    },
  };
  const e = mapCheckoutError(400, wire, CFG);
  assert.ok(e.email && e.f_mode && e.ticketType && e._form);
  // A top-level `details` is not the wire shape: only the form-level message.
  assert.deepEqual(Object.keys(mapCheckoutError(400, { details: wire.error.details }, CFG)), ["_form"]);
  assert.match(mapCheckoutError(409, null, CFG).ticketType, /売り切れ/);
  assert.match(mapCheckoutError(429, null, CFG)._form, /集中/);
  assert.match(mapCheckoutError(503, null, CFG)._form, /準備中/);
});

test("parseConfig validates shape", () => {
  assert.equal(parseConfig(null), null);
  assert.equal(parseConfig({ enabled: "yes" }), null);
  const c = parseConfig({ enabled: true, paymentReady: false, fields: [{ id: "a", label: "A", type: "weird" }], types: [{ id: "t", name: "T", priceJpy: 0 }] });
  assert.deepEqual(c, {
    enabled: true,
    paymentReady: false,
    fields: [{ id: "a", label: "A", type: "text", required: false, options: [] }],
    types: [{ id: "t", name: "T", description: "", priceJpy: 0, soldOut: false }],
  });
});

test("handler: non-tickets path / flag off / config failure -> not handled", async () => {
  assert.equal(await handleTickets(new Request("https://lp.example/program/"), deps()), null);
  assert.equal(await handleTickets(new Request("https://lp.example/tickets"), deps({ getConfig: async () => ({ ...CFG, enabled: false }) })), null);
  assert.equal(await handleTickets(new Request("https://lp.example/tickets/"), deps({ getConfig: async () => null })), null);
});

test("handler: GET /tickets renders with no-store + noindex", async () => {
  const res = await handleTickets(new Request("https://lp.example/tickets/?canceled=1"), deps());
  assert.ok(res);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-robots-tag"), "noindex");
  assert.match(await res.text(), /お支払いはキャンセルされました/);
});

test("handler: demo checkout validates locally then redirects to thanks", async () => {
  const d = deps({ demo: true, getConfig: async () => DEMO_CONFIG, internal: null });
  const bad = await handleTickets(post("/tickets/checkout", { ticketType: "demo-general", name: "", email: "" }), d);
  assert.equal(bad?.status, 400);
  assert.match(await bad!.text(), /氏名を入力してください/);
  const early = await handleTickets(post("/tickets/checkout", { ticketType: "demo-early", name: "A", email: "a@b.jp", f_attendance: "現地" }), d);
  assert.equal(early?.status, 400);
  const ok = await handleTickets(post("/tickets/checkout", { ticketType: "demo-general", name: "A", email: "a@b.jp", f_attendance: "現地" }), d);
  assert.equal(ok?.status, 303);
  assert.equal(ok?.headers.get("location"), "/tickets/thanks?order=demo");
  const thanks = await handleTickets(new Request("https://lp.example/tickets/thanks?order=demo"), d);
  assert.match(await thanks!.text(), /お申し込みが完了しました/);
});

test("handler: checkout forwards JSON with origin and redirects to Stripe", async () => {
  const d = deps();
  const res = await handleTickets(post("/tickets/checkout", VALID, { origin: "https://lp.example" }), d);
  assert.equal(res?.status, 303);
  assert.equal(res?.headers.get("location"), "https://checkout.stripe.com/c/pay/cs_1");
  assert.equal(d.calls[0].path, "/lp/internal/tickets/checkout");
  const sent = JSON.parse(String(d.calls[0].init.body));
  assert.equal(sent.origin, "https://lp.example");
  assert.equal(sent.ticketTypeId, "general");
  assert.deepEqual(sent.answers, { org: "", mode: "現地", agree: "はい" });
});

test("handler: cross-origin post is rejected; honeypot silently redirects without calling upstream", async () => {
  const d = deps();
  const x = await handleTickets(post("/tickets/checkout", VALID, { origin: "https://evil.example" }), d);
  assert.equal(x?.status, 403);
  const hp = await handleTickets(post("/tickets/checkout", { ...VALID, website: "x" }), d);
  assert.equal(hp?.status, 303);
  assert.equal(hp?.headers.get("location"), "/tickets/thanks");
  assert.equal(d.calls.length, 0);
});

test("handler: upstream 409 re-renders with sold-out message and refetches config", async () => {
  let invalidated = false;
  const d = deps({
    invalidate: () => {
      invalidated = true;
    },
    internal: async () => Response.json({ error: "sold_out" }, { status: 409 }),
  });
  const res = await handleTickets(post("/tickets/checkout", VALID), d);
  assert.equal(res?.status, 409);
  assert.ok(invalidated);
  const html = await res!.text();
  assert.match(html, /売り切れました/);
  assert.match(html, /value="山田 太郎"/);
});

test("handler: thanks with session_id calls confirm", async () => {
  const mk = (body: unknown) =>
    deps({ internal: async () => Response.json(body) });
  const paid = await handleTickets(new Request("https://lp.example/tickets/thanks?session_id=cs_1"), mk({ status: "paid", ticketTypeName: "一般" }));
  const t = await paid!.text();
  assert.match(t, /お申し込みが完了しました/);
  assert.match(t, /一般/);
  const pending = await handleTickets(new Request("https://lp.example/tickets/thanks?session_id=cs_1"), mk({ status: "pending" }));
  assert.match(await pending!.text(), /決済を確認中です（数分後にメールをご確認ください）/);
});

test("handler: thanks with order confirms by orderId (query string alone never shows success)", async () => {
  const d = deps({
    internal: async (path, init) => {
      d.calls.push({ path, init });
      const { orderId } = JSON.parse(String(init.body)) as { orderId?: string };
      return Response.json(orderId === "tko_1" ? { status: "paid", ticketTypeName: "招待" } : { status: "unknown" });
    },
  });
  const ok = await handleTickets(new Request("https://lp.example/tickets/thanks?order=tko_1"), d);
  const t = await ok!.text();
  assert.match(t, /お申し込みが完了しました/);
  assert.match(t, /招待/);
  assert.equal(d.calls[0].path, "/lp/internal/tickets/confirm");
  assert.deepEqual(JSON.parse(String(d.calls[0].init.body)), { orderId: "tko_1" });
  const forged = await handleTickets(new Request("https://lp.example/tickets/thanks?order=whatever"), d);
  assert.doesNotMatch(await forged!.text(), /お申し込みが完了しました/);
});

test("handler: webhook forwards raw body + signature regardless of flag", async () => {
  const d = deps({
    getConfig: async () => null,
    internal: async (path, init) => {
      d.calls.push({ path, init });
      return Response.json({ received: true });
    },
  });
  const res = await handleTickets(
    new Request("https://lp.example/tickets/stripe-webhook", { method: "POST", headers: { "stripe-signature": "t=1,v1=abc" }, body: '{"id":"evt"}' }),
    d,
  );
  assert.equal(res?.status, 200);
  assert.equal(d.calls[0].path, "/lp/internal/tickets/stripe-webhook");
  assert.equal((d.calls[0].init.headers as Record<string, string>)["stripe-signature"], "t=1,v1=abc");
  assert.equal(new TextDecoder().decode(d.calls[0].init.body as ArrayBuffer), '{"id":"evt"}');
});

test("CTA html", () => {
  const cta = ticketsCta();
  assert.match(cta, /id="lp-tickets-cta"/);
  assert.match(cta, /href="\/tickets"/);
  assert.match(cta, /チケットを購入/);
  assert.match(cta, /right:16px;bottom:16px/);
});
