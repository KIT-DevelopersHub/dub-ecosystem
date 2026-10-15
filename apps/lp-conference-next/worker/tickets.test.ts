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
  previewConfig,
  renderThanksPage,
  renderTicketsPage,
  splitDayLabel,
  ticketsCta,
  ticketsCtaSwap,
  ticketsInjection,
  CTA_SWAP_SELECTOR,
  COUPON_MSG,
  DEMO_COUPONS,
  normalizeCouponCode,
  quantityCap,
  FailureLimiter,
  COUPON_FAIL_MAX,
  COUPON_FAIL_WINDOW_MS,
  type PublicTicketType,
  type TicketConfig,
  type TicketsDeps,
  senderKeyFor,
  senderNetwork,
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
  couponOnly: false,
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
      { id: "t", name: "T", description: "", priceJpy: 0, dayLabel: "", maxPerOrder: 10, remaining: null, soldOut: false, couponOnly: false },
      { id: "u", name: "U", description: "", priceJpy: 500, dayLabel: "Day 1", maxPerOrder: 4, remaining: 0, soldOut: true, couponOnly: false },
    ],
  });
  assert.equal(parseConfig({ enabled: true, fields: [], types: [] })?.ctaEnabled, false);
  // preview is decided by the Worker, never taken from the response.
  assert.equal(parseConfig({ enabled: true, preview: true, fields: [], types: [] })?.preview, false);
});

test("previewConfig: ?tickets=on shows sales as a preview, off hides them, none keeps the real state", () => {
  const off = { ...CFG, enabled: false };
  assert.deepEqual(previewConfig(off, "on"), { ...off, enabled: true, preview: true });
  assert.equal(previewConfig(off, null), off);
  assert.equal(previewConfig(off, "off"), off);
  assert.equal(previewConfig(CFG, "on"), CFG);
  assert.equal(previewConfig(CFG, "off")?.enabled, false);
  assert.equal(previewConfig(CFG, null), CFG);
  assert.equal(previewConfig(null, "on"), null);
});

test("handler: preview shows the page with a notice but never checks out", async () => {
  const d = deps({ getConfig: async () => ({ ...CFG, preview: true }) });
  const page = await handleTickets(new Request("https://lp.example/tickets?version=3.4"), d);
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

test("DEMO_CONFIG: 2 days x (一般/学生), one low stock, one sold out, CTA on, one coupon-only type", () => {
  assert.equal(DEMO_CONFIG.ctaEnabled, true);
  assert.deepEqual(groupByDay(DEMO_CONFIG.types.filter((t) => !t.couponOnly)).map((g) => g.types.length), [2, 2]);
  const invite = DEMO_CONFIG.types.filter((t) => t.couponOnly);
  assert.equal(invite.length, 1);
  assert.equal(invite[0].priceJpy, 0);
  for (const c of Object.values(DEMO_COUPONS)) assert.equal(c.ticketTypeId, invite[0].id);
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
    clientKey: null,
  });
});

test("senderNetwork: IPv4 as is; IPv6 (any spelling) cut to its /64", () => {
  assert.equal(senderNetwork("203.0.113.7"), "203.0.113.7");
  assert.equal(senderNetwork("2001:db8:0:1::5"), "2001:db8:0:1::/64");
  assert.equal(senderNetwork("2001:0DB8:0000:0001:ffff:1:2:3"), "2001:db8:0:1::/64");
  assert.equal(senderNetwork("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(senderNetwork("::1"), "0:0:0:0::/64");
  assert.equal(senderNetwork("bogus:ip"), "bogus:ip");
});

test("handler: checkout sends a hashed sender key (never the raw IP), distinct from the proposals key", async () => {
  const d = deps();
  await handleTickets(post("/tickets/checkout", VALID, { "cf-connecting-ip": "203.0.113.7" }), d);
  const sent = JSON.parse(String(d.calls[0].init.body));
  assert.match(sent.clientKey, /^[a-f0-9]{32}$/);
  assert.ok(!String(d.calls[0].init.body).includes("203.0.113.7"));
  const req = () => new Request("https://x", { headers: { "cf-connecting-ip": "203.0.113.7" } });
  assert.equal(sent.clientKey, await senderKeyFor(req(), "lp-tickets"));
  assert.notEqual(sent.clientKey, await senderKeyFor(req(), "lp-proposals"));
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

test("handler: thanks still confirms when sales were turned off / config unavailable mid-checkout", async () => {
  for (const getConfig of [async () => ({ ...CFG, enabled: false }), async () => null]) {
    const d = deps({
      getConfig,
      internal: async (path, init) => {
        d.calls.push({ path, init });
        return Response.json({ status: "paid", summary: "一般 Day 1 x1" });
      },
    });
    const res = await handleTickets(new Request("https://lp.example/tickets/thanks?session_id=cs_1"), d);
    assert.equal(res?.status, 200);
    assert.match(await res!.text(), /お申し込みが完了しました/);
    assert.equal(d.calls[0].path, "/lp/internal/tickets/confirm");
  }
  // the form itself stays gated
  assert.equal(await handleTickets(new Request("https://lp.example/tickets"), deps({ getConfig: async () => null })), null);
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

// ---------- coupon codes ----------

const INVITE = tt({ id: "invite", name: "招待枠", priceJpy: 0, dayLabel: "Day 1 - 9/13(月)", maxPerOrder: 5, remaining: 4, couponOnly: true });
const CPN_CFG: TicketConfig = { ...CFG, types: [...CFG.types, INVITE] };
const APPLIED = { code: "ABCDE23456", ticketTypeId: "invite", remainingUses: 3 };
const BUYER = { name: "山田 太郎", email: "taro@example.com", f_mode: "現地", f_agree: "はい" };
const errBody = (status: number, error: unknown) => Response.json({ error }, { status });

/** internal() that answers the coupon endpoint with `coupon` and checkout with `checkout`. */
function cpnDeps(coupon: () => Response, checkout: () => Response = () => Response.json({ redirectUrl: "https://lp.example/tickets/thanks?order=tko_1" })) {
  const d = deps({
    getConfig: async () => CPN_CFG,
    internal: async (path, init) => {
      d.calls.push({ path, init });
      return path === "/lp/internal/tickets/coupon" ? coupon() : checkout();
    },
  });
  return d;
}
const okCoupon = (remainingUses = 3) => () => Response.json({ ticketTypeId: "invite", remainingUses });

test("normalizeCouponCode / parseConfig couponOnly / matchTicketsRoute coupon", () => {
  assert.equal(normalizeCouponCode(" abcde-23456 "), "ABCDE23456");
  assert.equal(normalizeCouponCode("ab"), null);
  assert.equal(normalizeCouponCode("ABC!DE"), null);
  const c = parseConfig({ enabled: true, fields: [], types: [{ id: "t", name: "T", priceJpy: 0, couponOnly: true }, { id: "u", name: "U", priceJpy: 0 }] });
  assert.deepEqual(c?.types.map((t) => t.couponOnly), [true, false]);
  assert.equal(matchTicketsRoute("/tickets/coupon/"), "coupon");
});

test("quantityCap: coupon caps at min(remainingUses, maxPerOrder, remaining); locks other types", () => {
  assert.equal(quantityCap(INVITE, true, null), 0);
  assert.equal(quantityCap(INVITE, true, APPLIED), 3);
  assert.equal(quantityCap(INVITE, true, { ...APPLIED, remainingUses: 50 }), 4);
  assert.equal(quantityCap({ ...INVITE, remaining: null }, true, { ...APPLIED, remainingUses: 50 }), 5);
  assert.equal(quantityCap({ ...INVITE, soldOut: true, remaining: 0 }, true, APPLIED), 0);
  // payment readiness does not matter for a 0-yen coupon line
  assert.equal(quantityCap(INVITE, false, APPLIED), 3);
  assert.equal(quantityCap(CFG.types[0], true, APPLIED), 0);
  assert.equal(quantityCap(CFG.types[0], true, null), 5);
});

test("render: preview keeps ?tickets=on on the coupon / checkout targets and 解除 (it only lives in the URL)", () => {
  const html = renderTicketsPage({ config: { ...CPN_CFG, preview: true } });
  assert.match(html, /action="\/tickets\/coupon\?tickets=on"/);
  assert.match(html, /action="\/tickets\/checkout\?tickets=on"/);
  const applied = renderTicketsPage({
    config: { ...CPN_CFG, preview: true },
    coupon: { code: "TRYFREE234", ticketTypeId: "invite", remainingUses: 3 },
  });
  assert.match(applied, /href="\/tickets\?tickets=on">解除/);
  // published (not preview): plain targets
  const live = renderTicketsPage({ config: CPN_CFG });
  assert.match(live, /action="\/tickets\/checkout" /);
});

test("render: coupon-only types are hidden from the normal list; coupon entry posts to its own form", () => {
  const html = renderTicketsPage({ config: CPN_CFG });
  assert.doesNotMatch(html, /qty_invite/);
  assert.doesNotMatch(html, /招待枠/);
  assert.match(html, /<form id="tk-coupon" method="post" action="\/tickets\/coupon" novalidate><\/form>/);
  assert.match(html, /クーポンコードをお持ちの方/);
  assert.match(html, /<input type="text" id="couponCode" name="couponCode" form="tk-coupon"/);
  assert.match(html, /<button type="submit" class="cpn-btn" form="tk-coupon">適用<\/button>/);
  // the purchase submit stays the first submit button owned by form.buy (Enter in buyer fields buys)
  assert.ok(html.indexOf('class="submit"') > html.indexOf("cpn-btn"));
  assert.doesNotMatch(html, /type="hidden" name="couponCode"/);
  // only coupon-only types on sale: the page stays open as a coupon entry
  const only = renderTicketsPage({ config: { ...CFG, types: [INVITE] } });
  assert.match(only, /一般販売中のチケットはありません/);
  assert.match(only, /id="couponCode"/);
  assert.match(renderTicketsPage({ config: { ...CFG, types: [{ ...INVITE, soldOut: true, remaining: 0 }] } }), /受付準備中/);
});

test("render: applied coupon shows its type as 無料（クーポン適用）, caps quantity, locks others, carries the code", () => {
  const html = renderTicketsPage({ config: CPN_CFG, coupon: APPLIED, values: { qty_invite: "2" } });
  assert.match(html, /無料<small class="cp">（クーポン適用）<\/small>/);
  assert.match(html, /<span class="badge cp">クーポン適用<\/span>/);
  assert.match(html, /name="qty_invite"[^>]*>(<option[^>]*>\d+<\/option>){4}<\/select>/);
  assert.match(html, /data-id="invite"[^>]*data-price="0"/);
  assert.match(html, /name="qty_general" disabled/);
  assert.match(html, /name="qty_student" disabled/);
  assert.match(html, /クーポン適用中は選べません/);
  assert.match(html, /<input type="hidden" name="couponCode" value="ABCDE23456">/);
  assert.match(html, /<a class="cpn-clear" href="\/tickets">解除<\/a>/);
  assert.match(html, /1 回 3 枚まで/);
  assert.doesNotMatch(html, /id="tk-coupon"/);
  assert.doesNotMatch(html, /Stripe/);
  assert.match(html, />申し込む</);
  assert.match(html, /data-sum-count>2枚</);
  assert.match(html, /data-sum-total>無料</);
  const js = /<script>([\s\S]*)<\/script><\/body>/.exec(html)![1];
  assert.doesNotThrow(() => new Function(js));
});

test("parseCheckoutForm with a coupon: only its type, up to its remaining uses; couponCode in the input", () => {
  const ok = parseCheckoutForm(form({ ...BUYER, qty_invite: "3" }), CPN_CFG, APPLIED);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.input.items, [{ ticketTypeId: "invite", quantity: 3 }]);
    assert.equal(ok.input.couponCode, "ABCDE23456");
  }
  const over = parseCheckoutForm(form({ ...BUYER, qty_invite: "4" }), CPN_CFG, APPLIED);
  assert.equal(!over.ok && over.errors.qty_invite, "このクーポンで申し込めるのは残り3枚です");
  const mixed = parseCheckoutForm(form({ ...BUYER, qty_invite: "1", qty_general: "1" }), CPN_CFG, APPLIED);
  assert.match(!mixed.ok ? mixed.errors.qty_general : "", /クーポンの対象券種のみ/);
  const noCode = parseCheckoutForm(form({ ...BUYER, qty_invite: "1" }), CPN_CFG);
  assert.equal(!noCode.ok && noCode.errors.qty_invite, COUPON_MSG.couponRequired);
  // without a coupon the input has no couponCode key at all
  const plain = parseCheckoutForm(form(VALID), CFG);
  assert.ok(plain.ok && !("couponCode" in plain.input));
});

test("mapCheckoutError: coupon reasons in Japanese", () => {
  const v = (details: unknown[]) => mapCheckoutError(400, { error: { code: "VALIDATION_FAILED", details } }, CPN_CFG);
  assert.equal(v([{ field: "couponCode", reason: "invalid" }]).couponCode, "クーポンコードが正しくないか、利用できません");
  assert.equal(v([{ field: "couponCode", reason: "not_applicable" }]).couponCode, COUPON_MSG.notApplicable);
  const req = v([{ field: "items.invite", reason: "coupon_required" }]);
  assert.equal(req.couponCode, COUPON_MSG.couponRequired);
  assert.equal(req.qty_invite, COUPON_MSG.couponRequired);
  const up = mapCheckoutError(409, { error: { code: "LP_TICKET_COUPON_USED_UP", details: { reason: "coupon_used_up" } } }, CPN_CFG);
  assert.equal(up.couponCode, "このクーポンは使用上限に達しています");
  assert.ok(up._form && !up.items);
});

test("handler: POST /tickets/coupon relays the normalized code (+ hashed sender key) and renders the applied page", async () => {
  const d = cpnDeps(okCoupon(3));
  const res = await handleTickets(
    post("/tickets/coupon", { couponCode: " abcde-23456 " }, { origin: "https://lp.example", "cf-connecting-ip": "203.0.113.7" }),
    d,
  );
  assert.equal(res?.status, 200);
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].path, "/lp/internal/tickets/coupon");
  const sent = JSON.parse(String(d.calls[0].init.body));
  assert.equal(sent.code, "ABCDE23456");
  assert.match(sent.clientKey, /^[a-f0-9]{32}$/);
  assert.ok(!String(d.calls[0].init.body).includes("203.0.113.7"));
  const html = await res!.text();
  assert.match(html, /クーポン適用中/);
  assert.match(html, /<option value="1" selected>1<\/option>/);
  assert.match(html, /data-sum-count>1枚</);
  // GET falls back to the page, cross-origin is refused
  assert.equal((await handleTickets(new Request("https://lp.example/tickets/coupon"), d))?.status, 303);
  assert.equal((await handleTickets(post("/tickets/coupon", { couponCode: "ABCDE23456" }, { origin: "https://evil.example" }), d))?.status, 403);
});

test("handler: coupon errors (invalid / used up / sales off / malformed) in Japanese, code kept in the input", async () => {
  const cases: Array<[() => Response, number, RegExp]> = [
    [() => errBody(400, { code: "VALIDATION_FAILED", details: [{ field: "couponCode", reason: "invalid" }] }), 400, /クーポンコードが正しくないか、利用できません/],
    [() => errBody(409, { code: "LP_TICKET_COUPON_USED_UP", details: { reason: "coupon_used_up" } }), 409, /このクーポンは使用上限に達しています/],
    [() => errBody(404, { code: "NOT_FOUND" }), 404, /現在お申し込みを受け付けていません/],
    [() => errBody(429, { code: "RATE_LIMITED" }), 429, /集中/],
    [() => new Response("boom", { status: 500 }), 502, /クーポンを確認できませんでした/],
    // 200 with a type the page does not know = can not be offered
    [() => Response.json({ ticketTypeId: "ghost", remainingUses: 2 }), 400, /クーポンコードが正しくないか/],
  ];
  for (const [up, status, msg] of cases) {
    const res = await handleTickets(post("/tickets/coupon", { couponCode: "ABCDE23456" }), cpnDeps(up));
    assert.equal(res?.status, status, String(msg));
    const html = await res!.text();
    assert.match(html, msg);
    assert.doesNotMatch(html, /クーポン適用中/);
    if (status === 400 || status === 409) assert.match(html, /id="couponCode"[^>]*value="ABCDE23456"/);
  }
  // locally malformed / empty codes never reach lp-analytics
  const d = cpnDeps(okCoupon());
  assert.equal((await handleTickets(post("/tickets/coupon", { couponCode: "<b>!" }), d))?.status, 400);
  const empty = await handleTickets(post("/tickets/coupon", { couponCode: "" }), d);
  assert.match(await empty!.text(), /クーポンコードを入力してください/);
  assert.equal(d.calls.length, 0);
});

test("handler: checkout with a coupon re-checks the code, then forwards couponCode with only its line", async () => {
  const d = cpnDeps(okCoupon(3));
  const res = await handleTickets(post("/tickets/checkout", { ...BUYER, couponCode: "ABCDE23456", qty_invite: "2" }, { origin: "https://lp.example" }), d);
  assert.equal(res?.status, 303);
  assert.equal(res?.headers.get("location"), "https://lp.example/tickets/thanks?order=tko_1");
  assert.deepEqual(d.calls.map((c) => c.path), ["/lp/internal/tickets/coupon", "/lp/internal/tickets/checkout"]);
  const sent = JSON.parse(String(d.calls[1].init.body));
  assert.deepEqual(sent.items, [{ ticketTypeId: "invite", quantity: 2 }]);
  assert.equal(sent.couponCode, "ABCDE23456");
  assert.doesNotMatch(String(d.calls[1].init.body), /price|amount/i);
  // over the code's remaining uses: stopped locally with the coupon still applied
  const d2 = cpnDeps(okCoupon(1));
  const over = await handleTickets(post("/tickets/checkout", { ...BUYER, couponCode: "ABCDE23456", qty_invite: "2" }), d2);
  assert.equal(over?.status, 400);
  const html = await over!.text();
  assert.match(html, /このクーポンで申し込めるのは残り1枚です/);
  assert.match(html, /type="hidden" name="couponCode" value="ABCDE23456"/);
  assert.equal(d2.calls.length, 1);
});

test("handler: checkout with a code that stopped working falls back to the normal page with the reason", async () => {
  const d = cpnDeps(() => errBody(400, { code: "VALIDATION_FAILED", details: [{ field: "couponCode", reason: "invalid" }] }));
  const res = await handleTickets(post("/tickets/checkout", { ...BUYER, couponCode: "ABCDE23456", qty_invite: "1" }), d);
  assert.equal(res?.status, 400);
  const html = await res!.text();
  assert.match(html, /クーポンコードが正しくないか、利用できません/);
  assert.doesNotMatch(html, /type="hidden" name="couponCode"/);
  assert.match(html, /value="山田 太郎"/);
  assert.equal(d.calls.length, 1);
});

test("handler: checkout 409 coupon_used_up re-checks the code (fresh cap, or dropped when nothing is left)", async () => {
  let left = 1;
  const d = cpnDeps(
    () => (left > 0 ? Response.json({ ticketTypeId: "invite", remainingUses: left }) : errBody(409, { code: "LP_TICKET_COUPON_USED_UP", details: { reason: "coupon_used_up" } })),
    () => {
      left = 1;
      return errBody(409, { code: "LP_TICKET_COUPON_USED_UP", details: { reason: "coupon_used_up" } });
    },
  );
  left = 3;
  const res = await handleTickets(post("/tickets/checkout", { ...BUYER, couponCode: "ABCDE23456", qty_invite: "3" }), d);
  assert.equal(res?.status, 409);
  const html = await res!.text();
  assert.match(html, /このクーポンは使用上限に達しています/);
  assert.match(html, /1 回 1 枚まで/);
  assert.match(html, /type="hidden" name="couponCode"/);

  const gone = cpnDeps(
    () => (gone.calls.length > 1 ? errBody(409, { code: "LP_TICKET_COUPON_USED_UP" }) : Response.json({ ticketTypeId: "invite", remainingUses: 2 })),
    () => errBody(409, { code: "LP_TICKET_COUPON_USED_UP", details: { reason: "coupon_used_up" } }),
  );
  const res2 = await handleTickets(post("/tickets/checkout", { ...BUYER, couponCode: "ABCDE23456", qty_invite: "2" }), gone);
  const html2 = await res2!.text();
  assert.match(html2, /このクーポンは使用上限に達しています/);
  assert.doesNotMatch(html2, /type="hidden" name="couponCode"/);
  assert.match(html2, /id="couponCode"[^>]*value="ABCDE23456"/);
});

test("handler: demo resolves coupons locally (never calls lp-analytics) and checks out to thanks", async () => {
  const d = deps({ demo: true, getConfig: async () => DEMO_CONFIG, internal: null });
  const page = await (await handleTickets(new Request("https://lp.example/tickets"), d))!.text();
  assert.doesNotMatch(page, /qty_demo-invite-d1/);
  assert.match(page, /デモ用コード: TRYFREE234/);
  const ok = await handleTickets(post("/tickets/coupon", { couponCode: "tryfree234" }), d);
  assert.equal(ok?.status, 200);
  const html = await ok!.text();
  assert.match(html, /無料<small class="cp">（クーポン適用）<\/small>/);
  assert.match(html, /name="qty_demo-invite-d1"[^>]*>(<option[^>]*>\d+<\/option>){4}<\/select>/);
  const used = await handleTickets(post("/tickets/coupon", { couponCode: "USEDUP2345" }), d);
  assert.equal(used?.status, 409);
  assert.match(await used!.text(), /使用上限に達しています/);
  assert.equal((await handleTickets(post("/tickets/coupon", { couponCode: "NOPE234567" }), d))?.status, 400);
  const done = await handleTickets(
    post("/tickets/checkout", { "qty_demo-invite-d1": "2", couponCode: "TRYFREE234", name: "A", email: "a@b.jp", f_attendance: "現地" }),
    d,
  );
  assert.equal(done?.status, 303);
  assert.match(decodeURIComponent(done!.headers.get("location")!), /summary=招待 Day 1 x2$/);
  // the coupon-only type can not be bought without the code
  const noCode = await handleTickets(post("/tickets/checkout", { "qty_demo-invite-d1": "1", name: "A", email: "a@b.jp", f_attendance: "現地" }), d);
  assert.equal(noCode?.status, 400);
});

test("handler: wrong coupon codes are limited per sender network (applied codes never count)", async () => {
  let t = 0;
  const limiter = new FailureLimiter(COUPON_FAIL_MAX, COUPON_FAIL_WINDOW_MS, () => t);
  let valid = false;
  const d = cpnDeps(() =>
    valid ? Response.json({ ticketTypeId: "invite", remainingUses: 3 }) : errBody(400, { code: "VALIDATION_FAILED", details: [{ field: "couponCode", reason: "invalid" }] }),
  );
  d.couponLimiter = limiter;
  const ip = (v: string) => ({ "cf-connecting-ip": v });
  for (let i = 0; i < COUPON_FAIL_MAX; i++) {
    assert.equal((await handleTickets(post("/tickets/coupon", { couponCode: `WRONG${i}2345` }, ip("203.0.113.7")), d))?.status, 400);
  }
  valid = true;
  const blocked = await handleTickets(post("/tickets/coupon", { couponCode: "ABCDE23456" }, ip("203.0.113.7")), d);
  assert.equal(blocked?.status, 429);
  assert.match(await blocked!.text(), /入力回数が上限に達しました/);
  assert.equal(d.calls.length, COUPON_FAIL_MAX, "blocked attempts never reach lp-analytics");
  // the checkout path can not be used to keep guessing either
  assert.equal((await handleTickets(post("/tickets/checkout", { ...BUYER, couponCode: "ABCDE23456", qty_invite: "1" }, ip("203.0.113.7")), d))?.status, 429);
  // another sender is unaffected; successes do not count
  for (let i = 0; i < COUPON_FAIL_MAX + 2; i++) {
    assert.equal((await handleTickets(post("/tickets/coupon", { couponCode: "ABCDE23456" }, ip("198.51.100.9")), d))?.status, 200);
  }
  // window over -> allowed again
  t += COUPON_FAIL_WINDOW_MS + 1;
  assert.equal((await handleTickets(post("/tickets/coupon", { couponCode: "ABCDE23456" }, ip("203.0.113.7")), d))?.status, 200);
});
