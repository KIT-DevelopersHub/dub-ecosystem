// Run: node --test worker/tickets.test.ts (Node >= 22.18 strips TS types natively).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEMO_CONFIG,
  escapeHtml,
  formatPrice,
  groupByDay,
  handleTickets,
  itemsSummary,
  mapCheckoutError,
  matchTicketsRoute,
  parseCheckoutForm,
  parseConfig,
  renderThanksPage,
  renderTicketsPage,
  splitDayLabel,
  ticketsCta,
  ticketsCtaSwap,
  ticketsInjection,
  CTA_SWAP_SELECTOR,
  type PublicTicketType,
  type TicketConfig,
  type TicketsDeps,
} from "./tickets.ts";

const XSS = '<script>alert("x")</script>';
const tt = (o: Partial<PublicTicketType> & { id: string }): PublicTicketType => ({
  name: o.id,
  description: "",
  priceJpy: 1000,
  dayLabel: "",
  maxPerOrder: 10,
  remaining: null,
  soldOut: false,
  ...o,
});
const CFG: TicketConfig = {
  enabled: true,
  preview: false,
  ctaEnabled: false,
  paymentReady: true,
  fields: [
    { id: "org", label: "所属", type: "text", required: false, options: [] },
    { id: "mode", label: "参加区分", type: "select", required: true, options: ["現地", "オンライン"] },
    { id: "agree", label: "規約に同意", type: "checkbox", required: true, options: [] },
  ],
  types: [
    tt({ id: "general", name: "一般", priceJpy: 3000, dayLabel: "Day 1 - 9/13(月)", maxPerOrder: 5 }),
    tt({ id: "student", name: "学生", priceJpy: 1000, dayLabel: "Day 1 - 9/13(月)", remaining: 3 }),
    tt({ id: "free", name: "招待", priceJpy: 0 }),
    tt({ id: "gone", name: "早割", priceJpy: 2000, dayLabel: "Day 2 - 9/14(火)", remaining: 0, soldOut: true }),
  ],
};
const form = (o: Record<string, string>) => new URLSearchParams(o);
const VALID = { qty_general: "2", qty_free: "1", name: "山田 太郎", email: "taro@example.com", f_mode: "現地", f_agree: "はい" };

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
    types: [tt({ id: XSS, name: XSS, description: XSS, priceJpy: 100, dayLabel: XSS })],
  };
  const html = renderTicketsPage({ config: cfg, values: { name: XSS, f_q: XSS }, errors: { _form: XSS, name: XSS } });
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!renderThanksPage({ status: "paid", summary: XSS }).includes("<script>alert"));
});

test("render: steppers, sold out / payment not ready / 受付準備中", () => {
  const html = renderTicketsPage({ config: CFG });
  assert.match(html, /売り切れ/);
  assert.match(html, /name="qty_gone" disabled/);
  // general: maxPerOrder 5 -> options 0..5; student: remaining 3 caps at 3.
  assert.match(html, /name="qty_general"[^>]*>(<option[^>]*>\d+<\/option>){6}<\/select>/);
  assert.match(html, /name="qty_student"[^>]*>(<option[^>]*>\d+<\/option>){4}<\/select>/);
  assert.match(html, /残りわずか 3枚/);
  assert.match(html, /<option value="0" selected>0<\/option>/);
  assert.match(html, /券種と枚数を選んでください/);
  assert.match(html, /購入手続きへ/);
  const notReady = renderTicketsPage({ config: { ...CFG, paymentReady: false } });
  assert.match(notReady, /決済準備中/);
  assert.match(notReady, /name="qty_general" disabled/);
  assert.doesNotMatch(notReady, /name="qty_free" disabled/);
  const none = renderTicketsPage({ config: { ...CFG, paymentReady: false, types: [CFG.types[0]] } });
  assert.match(none, /受付準備中/);
  assert.ok(!none.includes("<form"));
  assert.match(renderTicketsPage({ config: CFG, canceled: true }), /お支払いはキャンセルされました/);
  assert.match(renderTicketsPage({ config: CFG, demo: true }), /デモ環境です（実際の決済は行われません）/);
});

test("render: groups by day with headings in first-appearance order", () => {
  const html = renderTicketsPage({ config: CFG });
  const d1 = html.indexOf('<span class="day-k">Day 1</span><span class="day-d">9/13(月)</span>');
  const common = html.indexOf('<span class="day-k plain">共通</span>');
  const d2 = html.indexOf('<span class="day-k">Day 2</span><span class="day-d">9/14(火)</span>');
  assert.ok(d1 > 0 && common > d1 && d2 > common, `order ${d1} ${common} ${d2}`);
  assert.match(html, /対象日 Day 1 - 9\/13\(月\)/);
  // Only undated types -> no heading at all.
  const flat = renderTicketsPage({ config: { ...CFG, types: [tt({ id: "a" }), tt({ id: "b" })] } });
  assert.doesNotMatch(flat, /class="day-h"/);
});

test("groupByDay / splitDayLabel / itemsSummary", () => {
  const g = groupByDay([tt({ id: "a", dayLabel: "Day 2" }), tt({ id: "b", dayLabel: "" }), tt({ id: "c", dayLabel: "Day 2" })]);
  assert.deepEqual(
    g.map((x) => [x.dayLabel, x.types.map((t) => t.id)]),
    [["Day 2", ["a", "c"]], ["", ["b"]]],
  );
  assert.deepEqual(splitDayLabel("Day 1 - 9/13(月)"), { main: "Day 1", sub: "9/13(月)" });
  assert.deepEqual(splitDayLabel("Day 1 · 9/13(月)"), { main: "Day 1", sub: "9/13(月)" });
  assert.deepEqual(splitDayLabel("通し"), { main: "通し", sub: "" });
  assert.equal(
    itemsSummary([{ ticketTypeId: "general", quantity: 2 }, { ticketTypeId: "free", quantity: 1 }], CFG.types),
    "一般 Day 1 x2、招待 x1",
  );
});

test("parseCheckoutForm: multiple items (quantity > 0 only)", () => {
  const r = parseCheckoutForm(form({ ...VALID, qty_student: "0", f_org: "  KIT " }), CFG);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.input, {
    items: [
      { ticketTypeId: "general", quantity: 2 },
      { ticketTypeId: "free", quantity: 1 },
    ],
    name: "山田 太郎",
    email: "taro@example.com",
    answers: { org: "KIT", mode: "現地", agree: "はい" },
  });
});

test("parseCheckoutForm: zero tickets", () => {
  const r = parseCheckoutForm(form({ ...VALID, qty_general: "0", qty_free: "" }), CFG);
  assert.equal(!r.ok && r.errors.items, "チケットを 1 枚以上選んでください");
});

test("parseCheckoutForm: per-type limits, sold out, total cap, junk", () => {
  const over = parseCheckoutForm(form({ ...VALID, qty_general: "6" }), CFG);
  assert.match(!over.ok ? over.errors.qty_general : "", /5枚まで/);
  const low = parseCheckoutForm(form({ ...VALID, qty_student: "4" }), CFG);
  assert.match(!low.ok ? low.errors.qty_student : "", /残り3枚/);
  const gone = parseCheckoutForm(form({ ...VALID, qty_gone: "1" }), CFG);
  assert.match(!gone.ok ? gone.errors.qty_gone : "", /売り切れ/);
  const junk = parseCheckoutForm(form({ ...VALID, qty_general: "-1" }), CFG);
  assert.ok(!junk.ok && junk.errors.qty_general);
  const many: TicketConfig = {
    ...CFG,
    types: [tt({ id: "x", maxPerOrder: 20 }), tt({ id: "y", maxPerOrder: 20 })],
  };
  const total = parseCheckoutForm(form({ ...VALID, qty_x: "15", qty_y: "6" }), many);
  assert.match(!total.ok ? total.errors.items : "", /合計20枚まで/);
  assert.equal(parseCheckoutForm(form({ ...VALID, qty_general: "0", qty_x: "10", qty_y: "10" }), many).ok, true);
});

test("parseCheckoutForm: errors keep values (incl. quantities) on re-render", () => {
  const r = parseCheckoutForm(form({ qty_general: "3", name: "", email: "bad", f_mode: "宇宙", f_org: "x" }), CFG);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.spam, false);
  assert.deepEqual(Object.keys(r.errors).sort(), ["email", "f_agree", "f_mode", "name"]);
  assert.equal(r.values.f_org, "x");
  const html = renderTicketsPage({ config: CFG, values: r.values, errors: r.errors });
  assert.match(html, /value="bad"/);
  assert.match(html, /メールアドレスの形式が正しくありません/);
  assert.match(html, /<option value="3" selected>3<\/option>/);
  assert.match(html, /class="tk on"/);
  assert.match(html, /data-sum-count>3枚</);
  assert.match(html, /data-sum-total>¥9,000</);
});

test("parseCheckoutForm: paid type rejected when payment not ready; honeypot = spam", () => {
  const r = parseCheckoutForm(form(VALID), { ...CFG, paymentReady: false });
  assert.equal(!r.ok && r.errors.qty_general, "この券種は現在お申し込みいただけません");
  const s = parseCheckoutForm(form({ ...VALID, website: "http://spam" }), CFG);
  assert.equal(!s.ok && s.spam, true);
});

test("mapCheckoutError maps 400 details (items / items.<id>) and statuses", () => {
  // Same shape lp-analytics' dubErrorHandler emits: { error: { code, message, details } }.
  const wire = {
    error: {
      code: "VALIDATION_FAILED",
      message: "Validation failed",
      details: [
        { field: "email", reason: "x" },
        { field: "answers.mode", reason: "y" },
        { field: "items", reason: "too_many" },
        { field: "items.general", reason: "unavailable" },
      ],
    },
  };
  const e = mapCheckoutError(400, wire, CFG);
  assert.ok(e.email && e.f_mode && e._form);
  assert.match(e.items, /合計20枚まで/);
  assert.match(e.qty_general, /お申し込みいただけません/);
  // A top-level `details` is not the wire shape: only the form-level message.
  assert.deepEqual(Object.keys(mapCheckoutError(400, { details: wire.error.details }, CFG)), ["_form"]);
  const so = mapCheckoutError(409, { error: { code: "CONFLICT", details: { reason: "sold_out", ticketTypeId: "student" } } }, CFG);
  assert.match(so.qty_student, /売り切れ/);
  assert.ok(so._form);
  assert.ok(mapCheckoutError(409, null, CFG).items);
  assert.match(mapCheckoutError(429, null, CFG)._form, /集中/);
  assert.match(mapCheckoutError(503, null, CFG)._form, /準備中/);
});

test("parseConfig validates shape (v2 fields with defaults)", () => {
  assert.equal(parseConfig(null), null);
  assert.equal(parseConfig({ enabled: "yes" }), null);
  const c = parseConfig({
    enabled: true,
    ctaEnabled: true,
    paymentReady: false,
    fields: [{ id: "a", label: "A", type: "weird" }],
    types: [
      { id: "t", name: "T", priceJpy: 0 },
      { id: "u", name: "U", priceJpy: 500, dayLabel: " Day 1 ", maxPerOrder: 4, remaining: 0 },
    ],
  });
  assert.deepEqual(c, {
    enabled: true,
    preview: false,
    ctaEnabled: true,
    paymentReady: false,
    fields: [{ id: "a", label: "A", type: "text", required: false, options: [] }],
    types: [
      { id: "t", name: "T", description: "", priceJpy: 0, dayLabel: "", maxPerOrder: 10, remaining: null, soldOut: false },
      { id: "u", name: "U", description: "", priceJpy: 500, dayLabel: "Day 1", maxPerOrder: 4, remaining: 0, soldOut: true },
    ],
  });
  assert.equal(parseConfig({ enabled: true, fields: [], types: [] })?.ctaEnabled, false);
  assert.equal(parseConfig({ enabled: true, preview: true, fields: [], types: [] })?.preview, true);
});

test("handler: preview shows the page with a notice but never checks out", async () => {
  const d = deps({ getConfig: async () => ({ ...CFG, preview: true }) });
  const page = await handleTickets(new Request("https://lp.example/tickets?preview=x"), d);
  assert.equal(page?.status, 200);
  const html = await page!.text();
  assert.match(html, /data-lp-tk-preview/);
  assert.match(html, /まだ一般公開されていません/);
  const res = await handleTickets(post("/tickets/checkout", VALID, { origin: "https://lp.example" }), d);
  assert.equal(res?.status, 403);
  assert.match(await res!.text(), /プレビュー表示中のため、お申し込みはできません/);
  assert.equal(d.calls.length, 0);
  // Public page has no preview notice.
  assert.doesNotMatch(await (await handleTickets(new Request("https://lp.example/tickets"), deps()))!.text(), /data-lp-tk-preview/);
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

test("handler: demo checkout validates locally then redirects to thanks with summary", async () => {
  const d = deps({ demo: true, getConfig: async () => DEMO_CONFIG, internal: null });
  const bad = await handleTickets(post("/tickets/checkout", { "qty_demo-general-d1": "1", name: "", email: "" }), d);
  assert.equal(bad?.status, 400);
  assert.match(await bad!.text(), /氏名を入力してください/);
  const soldOut = await handleTickets(
    post("/tickets/checkout", { "qty_demo-student-d2": "1", name: "A", email: "a@b.jp", f_attendance: "現地" }),
    d,
  );
  assert.equal(soldOut?.status, 400);
  const ok = await handleTickets(
    post("/tickets/checkout", { "qty_demo-general-d1": "2", "qty_demo-student-d1": "1", name: "A", email: "a@b.jp", f_attendance: "現地" }),
    d,
  );
  assert.equal(ok?.status, 303);
  const loc = ok!.headers.get("location")!;
  assert.match(loc, /^\/tickets\/thanks\?order=demo&summary=/);
  const thanks = await handleTickets(new Request(`https://lp.example${loc}`), d);
  const t = await thanks!.text();
  assert.match(t, /お申し込みが完了しました/);
  assert.match(t, /<b>一般 Day 1 x2<\/b><b>学生 Day 1 x1<\/b>/);
});

test("DEMO_CONFIG: 2 days x (一般/学生), one low stock, one sold out, CTA on", () => {
  assert.equal(DEMO_CONFIG.ctaEnabled, true);
  assert.deepEqual(groupByDay(DEMO_CONFIG.types).map((g) => g.types.length), [2, 2]);
  assert.ok(DEMO_CONFIG.types.some((t) => t.remaining !== null && t.remaining > 0 && t.remaining <= 3));
  assert.ok(DEMO_CONFIG.types.some((t) => t.soldOut));
});

test("handler: checkout forwards items JSON with origin and redirects to Stripe", async () => {
  const d = deps();
  const res = await handleTickets(post("/tickets/checkout", VALID, { origin: "https://lp.example" }), d);
  assert.equal(res?.status, 303);
  assert.equal(res?.headers.get("location"), "https://checkout.stripe.com/c/pay/cs_1");
  assert.equal(d.calls[0].path, "/lp/internal/tickets/checkout");
  const sent = JSON.parse(String(d.calls[0].init.body));
  assert.deepEqual(sent, {
    items: [
      { ticketTypeId: "general", quantity: 2 },
      { ticketTypeId: "free", quantity: 1 },
    ],
    name: "山田 太郎",
    email: "taro@example.com",
    answers: { org: "", mode: "現地", agree: "はい" },
    origin: "https://lp.example",
  });
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

test("handler: upstream 409 re-renders with sold-out message under the type and refetches config", async () => {
  let invalidated = false;
  const d = deps({
    invalidate: () => {
      invalidated = true;
    },
    internal: async () =>
      Response.json({ error: { code: "CONFLICT", message: "sold out", details: { reason: "sold_out", ticketTypeId: "general" } } }, { status: 409 }),
  });
  const res = await handleTickets(post("/tickets/checkout", VALID), d);
  assert.equal(res?.status, 409);
  assert.ok(invalidated);
  const html = await res!.text();
  assert.match(html, /id="qty_general-err">残数が足りません/);
  assert.match(html, /value="山田 太郎"/);
  assert.match(html, /<option value="2" selected>2<\/option>/);
});

test("handler: thanks with session_id calls confirm and shows summary", async () => {
  const mk = (body: unknown) => deps({ internal: async () => Response.json(body) });
  const paid = await handleTickets(
    new Request("https://lp.example/tickets/thanks?session_id=cs_1"),
    mk({ status: "paid", summary: "一般 Day 1 x2、学生 Day 2 x1" }),
  );
  const t = await paid!.text();
  assert.match(t, /お申し込みが完了しました/);
  assert.match(t, /<b>一般 Day 1 x2<\/b><b>学生 Day 2 x1<\/b>/);
  const pending = await handleTickets(new Request("https://lp.example/tickets/thanks?session_id=cs_1"), mk({ status: "pending" }));
  assert.match(await pending!.text(), /決済を確認中です（数分後にメールをご確認ください）/);
});

test("handler: thanks with order confirms by orderId (query string alone never shows success)", async () => {
  const d = deps({
    internal: async (path, init) => {
      d.calls.push({ path, init });
      const { orderId } = JSON.parse(String(init.body)) as { orderId?: string };
      return Response.json(orderId === "tko_1" ? { status: "paid", summary: "招待 x1" } : { status: "unknown" });
    },
  });
  const ok = await handleTickets(new Request("https://lp.example/tickets/thanks?order=tko_1&summary=FORGED"), d);
  const t = await ok!.text();
  assert.match(t, /お申し込みが完了しました/);
  assert.match(t, /招待 x1/);
  assert.doesNotMatch(t, /FORGED/);
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

test("ticketsInjection: floating CTA follows enabled, button swap needs enabled && ctaEnabled", () => {
  assert.equal(ticketsInjection(null), "");
  assert.equal(ticketsInjection({ ...CFG, enabled: false, ctaEnabled: true }), "");
  const floatOnly = ticketsInjection({ ...CFG, ctaEnabled: false });
  assert.match(floatOnly, /id="lp-tickets-cta"/);
  assert.doesNotMatch(floatOnly, /lp-tickets-cta-swap/);
  const both = ticketsInjection({ ...CFG, ctaEnabled: true });
  assert.match(both, /id="lp-tickets-cta"/);
  assert.match(both, /id="lp-tickets-cta-swap"/);
  assert.doesNotMatch(both, /id="lp-tickets-preview"/);
  const preview = ticketsInjection({ ...CFG, preview: true, ctaEnabled: true });
  assert.match(preview, /id="lp-tickets-preview"/);
  assert.match(preview, /id="lp-tickets-cta-swap"/);
});

test("ticketsCtaSwap: targets, label, hydration wait, script parses", () => {
  const html = ticketsCtaSwap();
  for (const sel of [".site-head-cta", ".hero-cta--participant", ".svc-card--participant .svc-card-link", ".git-btn--primary"]) {
    assert.ok(CTA_SWAP_SELECTOR.includes(sel), sel);
    assert.ok(html.includes(sel), sel);
  }
  assert.match(html, /参加チケットを購入/);
  assert.match(html, /__reactFiber\$/);
  assert.match(html, /setTimeout\(tick,100\)/);
  assert.match(html, /n>=50/);
  assert.doesNotMatch(html, /replaceWith|removeChild|\.remove\(\)|innerHTML/);
  const js = /<script id="lp-tickets-cta-swap">([\s\S]*)<\/script>/.exec(html)![1];
  assert.doesNotThrow(() => new Function(js));
  assert.ok(!js.includes("</"), "no closing tag inside the inline script");
});

test("page inline script parses", () => {
  const html = renderTicketsPage({ config: CFG });
  const js = /<script>([\s\S]*)<\/script><\/body>/.exec(html)![1];
  assert.doesNotThrow(() => new Function(js));
});
