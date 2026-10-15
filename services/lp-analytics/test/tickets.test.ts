// LP チケット購入: LP管理 API (/lp/tickets*) + 公開 LP Worker 向け内部 API (/lp/internal/tickets*).
import { describe, it, expect } from "vitest";
import { createStripeClient, signStripePayload } from "../src/stripe";
import type {
  AppDeps,
  LpTicketCoupon,
  LpTicketCouponsPage,
  LpTicketOrder,
  LpTicketOrdersPage,
  LpTicketsState,
  LpTicketTypeSummary,
} from "../src/types";
import { stripeFrom } from "../src/index";
import { TicketService } from "../src/tickets";
import { get, makeApp, send, type RepoKind } from "./harness";

const body = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const INTERNAL = { "x-dub-internal": "1" };
const WHSEC = "whsec_test";
const NOW = "2026-10-07T03:00:00.000Z";
const NOW_SEC = Math.floor(Date.parse(NOW) / 1000);

interface StripeCall {
  url: string;
  method: string;
  auth: string | null;
  idempotencyKey: string | null;
  form: URLSearchParams | null;
}

type SessionOverride = { payment_status?: string; status?: string; amount_total?: number; currency?: string; livemode?: boolean };

/** Remembers each created session's real total so GET answers like Stripe; `session` overrides fields, `failGet` ids 500. */
function fakeStripe(session: SessionOverride = {}, opts: { key?: string; failGet?: Set<string> } = {}) {
  const calls: StripeCall[] = [];
  const totals = new Map<string, { amount: number; ref: string | null }>();
  let n = 0;
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method,
      auth: headers.get("authorization"),
      idempotencyKey: headers.get("idempotency-key"),
      form: typeof init?.body === "string" ? new URLSearchParams(init.body) : null,
    });
    if (method === "POST") {
      const id = `cs_test_${n++}`;
      const form = new URLSearchParams(init?.body as string);
      let amount = 0;
      for (let i = 0; form.has(`line_items[${i}][quantity]`); i++) {
        amount += Number(form.get(`line_items[${i}][price_data][unit_amount]`)) * Number(form.get(`line_items[${i}][quantity]`));
      }
      totals.set(id, { amount, ref: form.get("client_reference_id") });
      return Response.json({
        id,
        url: `https://checkout.stripe.com/c/pay/${id}`,
        status: "open",
        payment_status: "unpaid",
        client_reference_id: form.get("client_reference_id"),
        livemode: false,
      });
    }
    const id = url.split("/").pop()!;
    if (opts.failGet?.has(id)) return new Response("boom", { status: 500 });
    return Response.json({
      id,
      status: "complete",
      payment_status: "paid",
      amount_total: totals.get(id)?.amount ?? 0,
      currency: "jpy",
      livemode: false,
      payment_intent: `pi_${id}`,
      client_reference_id: totals.get(id)?.ref ?? null,
      ...session,
    });
  };
  return { calls, client: createStripeClient(opts.key ?? "sk_test_123", fetchFn) };
}

/** Test-mode Checkout Session object as Stripe sends it in a webhook. */
const cs = (o: Record<string, unknown>) => ({ livemode: false, currency: "jpy", ...o });

async function setup(
  kind: RepoKind,
  opts: { stripe?: ReturnType<typeof fakeStripe> | null; cap?: number; publish?: boolean; deps?: Partial<AppDeps> } = {},
) {
  const h = await makeApp(kind, "edit", 5000, null, opts.publish === false ? [] : ["lp:publish"], {
    stripe: opts.stripe ? opts.stripe.client : null,
    stripeWebhookSecret: WHSEC,
    ...(opts.cap !== undefined ? { dailyCheckoutCap: opts.cap } : {}),
    ...opts.deps,
  });
  return h;
}

type App = Awaited<ReturnType<typeof setup>>["app"];

async function addType(app: App, input: Record<string, unknown>): Promise<LpTicketTypeSummary> {
  const res = await app.fetch(
    send("POST", "/lp/tickets/types", { description: "", capacity: null, active: true, ...input }),
  );
  expect(res.status).toBe(201);
  return body<LpTicketTypeSummary>(res);
}

/** Issues a coupon for the type (needs lp:publish). */
async function issueCoupon(app: App, ticketTypeId: string, maxUses = 100, extra: Record<string, unknown> = {}): Promise<LpTicketCoupon> {
  const res = await app.fetch(send("POST", "/lp/tickets/coupons", { ticketTypeId, maxUses, ...extra }));
  expect(res.status).toBe(201);
  return body<LpTicketCoupon>(res);
}

async function enable(app: App) {
  expect((await app.fetch(send("POST", "/lp/tickets/enabled", { enabled: true }))).status).toBe(200);
}

/** `ticketTypeId` (+ `quantity`) is shorthand for a one-line `items`. */
const checkoutReq = ({ ticketTypeId, quantity, ...b }: Record<string, unknown>) =>
  send(
    "POST",
    "/lp/internal/tickets/checkout",
    {
      name: "山田 太郎",
      email: "taro@example.com",
      answers: {},
      origin: "https://hokuriku-it-conf.com",
      ...(ticketTypeId !== undefined ? { items: [{ ticketTypeId, quantity: quantity ?? 1 }] } : {}),
      ...b,
    },
    INTERNAL,
  );
const checkout = checkoutReq;

/** Events default to test mode (livemode: false) unless given. */
async function webhook(app: App, event: Record<string, unknown>, sig?: string) {
  const raw = JSON.stringify({ livemode: false, ...event });
  const header = sig ?? (await signStripePayload(raw, WHSEC, NOW_SEC));
  return app.fetch(
    new Request("https://lp/lp/internal/tickets/stripe-webhook", {
      method: "POST",
      headers: { ...INTERNAL, "stripe-signature": header, "content-type": "application/json" },
      body: raw,
    }),
  );
}

describe.each<RepoKind>(["memory", "d1"])("lp tickets (%s repo)", (kind) => {
  it("GET /lp/tickets: default state (disabled, payment not ready, no types)", async () => {
    const { app } = await setup(kind);
    const s = await body<LpTicketsState>(await app.fetch(get("/lp/tickets")));
    expect(s).toEqual({
      site: "hokuriku-it-conf.com",
      enabled: false,
      ctaEnabled: false,
      paymentReady: false,
      publicUrl: "https://hokuriku-it-conf.com/tickets",
      fields: [],
      types: [],
      totals: { sold: 0, revenueJpy: 0 },
      updatedAt: null,
      updatedBy: null,
    });
    const ready = await setup(kind, { stripe: fakeStripe() });
    expect((await body<LpTicketsState>(await ready.app.fetch(get("/lp/tickets")))).paymentReady).toBe(true);
  });

  it("enabled toggle needs lp:publish; records who switched", async () => {
    const noPublish = await setup(kind, { publish: false });
    expect((await noPublish.app.fetch(send("POST", "/lp/tickets/enabled", { enabled: true }))).status).toBe(403);
    const { app } = await setup(kind);
    expect((await app.fetch(send("POST", "/lp/tickets/enabled", { enabled: "yes" }))).status).toBe(400);
    const res = await app.fetch(send("POST", "/lp/tickets/enabled", { enabled: true }));
    expect(res.status).toBe(200);
    expect(await body<LpTicketsState>(res)).toMatchObject({ enabled: true, updatedBy: "usr_admin", updatedAt: NOW });
  });

  it("cta toggle needs lp:publish and is independent of enabled", async () => {
    const noPublish = await setup(kind, { publish: false });
    expect((await noPublish.app.fetch(send("POST", "/lp/tickets/cta", { enabled: true }))).status).toBe(403);
    const { app } = await setup(kind);
    expect((await app.fetch(send("POST", "/lp/tickets/cta", {}))).status).toBe(400);
    const res = await app.fetch(send("POST", "/lp/tickets/cta", { enabled: true }));
    expect(await body<LpTicketsState>(res)).toMatchObject({ enabled: false, ctaEnabled: true });
    await enable(app);
    const internal = await body<{ enabled: boolean; ctaEnabled: boolean }>(await app.fetch(get("/lp/internal/tickets", INTERNAL)));
    expect(internal).toMatchObject({ enabled: true, ctaEnabled: true });
  });

  it("dayLabel / maxPerOrder: defaults, trims, validates", async () => {
    const { app } = await setup(kind);
    const a = await addType(app, { name: "一般", priceJpy: 3000, dayLabel: " Day 1 " });
    expect(a).toMatchObject({ dayLabel: "Day 1", maxPerOrder: 10 });
    const b = await addType(app, { name: "学生", priceJpy: 1000, maxPerOrder: 2 });
    expect(b).toMatchObject({ dayLabel: "", maxPerOrder: 2 });
    for (const input of [{ dayLabel: "x".repeat(31) }, { maxPerOrder: 0 }, { maxPerOrder: 21 }, { maxPerOrder: 1.5 }]) {
      expect((await app.fetch(send("POST", "/lp/tickets/types", { name: "a", priceJpy: 100, ...input }))).status).toBe(400);
    }
    const patched = await app.fetch(send("PATCH", `/lp/tickets/types/${a.id}`, { dayLabel: "Day 2", maxPerOrder: 4 }));
    expect(await body<LpTicketTypeSummary>(patched)).toMatchObject({ name: "一般", dayLabel: "Day 2", maxPerOrder: 4 });
  });

  it("create / patch ticket type with validation; sortOrder appends", async () => {
    const { app } = await setup(kind);
    const a = await addType(app, { name: " 一般 ", priceJpy: 3000, capacity: 100 });
    expect(a).toMatchObject({
      name: "一般",
      priceJpy: 3000,
      capacity: 100,
      active: true,
      sortOrder: 0,
      stats: { sold: 0, pending: 0, revenueJpy: 0, remaining: 100 },
    });
    const b = await addType(app, { name: "招待", priceJpy: 0 });
    expect(b.sortOrder).toBe(1);
    expect(b.stats.remaining).toBeNull();

    const bad = [
      { name: "", priceJpy: 100 },
      { name: "x".repeat(61), priceJpy: 100 },
      { name: "a", priceJpy: 49 },
      { name: "a", priceJpy: 1 },
      { name: "a", priceJpy: -1 },
      { name: "a", priceJpy: 1_000_001 },
      { name: "a", priceJpy: 10.5 },
      { name: "a", priceJpy: 100, capacity: 0 },
      { name: "a", priceJpy: 100, capacity: 100_001 },
      { name: "a", priceJpy: 100, description: "x".repeat(301) },
    ];
    for (const input of bad) {
      expect((await app.fetch(send("POST", "/lp/tickets/types", { description: "", capacity: null, active: true, ...input }))).status).toBe(400);
    }

    const patched = await app.fetch(send("PATCH", `/lp/tickets/types/${a.id}`, { active: false, priceJpy: 50 }));
    expect(patched.status).toBe(200);
    expect(await body<LpTicketTypeSummary>(patched)).toMatchObject({ name: "一般", active: false, priceJpy: 50, capacity: 100 });
    expect((await app.fetch(send("PATCH", `/lp/tickets/types/${a.id}`, { capacity: -3 }))).status).toBe(400);
    expect((await app.fetch(send("PATCH", "/lp/tickets/types/nope", { active: true }))).status).toBe(404);

    const s = await body<LpTicketsState>(await app.fetch(get("/lp/tickets")));
    expect(s.types.map((t) => t.name)).toEqual(["一般", "招待"]);
  });

  it("fields: saves valid list, rejects bad ids / labels / options", async () => {
    const { app } = await setup(kind);
    const fields = [
      { id: "company", label: "所属", type: "text", required: false, options: ["ignored"] },
      { id: "role", label: "職種", type: "select", required: true, options: ["学生", "社会人"] },
      { id: "agree", label: "規約に同意", type: "checkbox", required: true, options: [] },
    ];
    const res = await app.fetch(send("POST", "/lp/tickets/fields", { fields }));
    expect(res.status).toBe(200);
    const s = await body<LpTicketsState>(res);
    expect(s.fields[0]).toEqual({ id: "company", label: "所属", type: "text", required: false, options: [] });
    expect(s.fields).toHaveLength(3);

    const bad = [
      [{ id: "Bad Id", label: "x", type: "text", required: false, options: [] }],
      [{ id: "email", label: "x", type: "text", required: false, options: [] }],
      [
        { id: "a", label: "x", type: "text", required: false, options: [] },
        { id: "a", label: "y", type: "text", required: false, options: [] },
      ],
      [{ id: "a", label: "", type: "text", required: false, options: [] }],
      [{ id: "a", label: "x", type: "date", required: false, options: [] }],
      [{ id: "a", label: "x", type: "select", required: false, options: [] }],
      [{ id: "a", label: "x", type: "text", required: "yes", options: [] }],
      Array.from({ length: 21 }, (_, i) => ({ id: `f${i}`, label: "x", type: "text", required: false, options: [] })),
    ];
    for (const f of bad) expect((await app.fetch(send("POST", "/lp/tickets/fields", { fields: f }))).status).toBe(400);
    expect((await body<LpTicketsState>(await app.fetch(get("/lp/tickets")))).fields).toHaveLength(3);
  });

  it("internal GET lists only active types in sort order, with soldOut", async () => {
    const { app } = await setup(kind);
    await enable(app);
    const a = await addType(app, { name: "A", priceJpy: 0, capacity: 1 });
    const b = await addType(app, { name: "B", priceJpy: 1000 });
    await app.fetch(send("PATCH", `/lp/tickets/types/${b.id}`, { active: false }));
    await addType(app, { name: "C", priceJpy: 0 });
    const code = (await issueCoupon(app, a.id)).code;
    expect((await app.fetch(checkout({ ticketTypeId: a.id, couponCode: code }))).status).toBe(200);

    expect((await app.fetch(get("/lp/internal/tickets", {}))).status).toBe(404);
    const res = await body<{ enabled: boolean; paymentReady: boolean; types: { name: string; soldOut: boolean }[] }>(
      await app.fetch(get("/lp/internal/tickets", INTERNAL)),
    );
    expect(res.enabled).toBe(true);
    expect(res.paymentReady).toBe(false);
    expect(res.types).toEqual([
      { id: a.id, name: "A", description: "", priceJpy: 0, dayLabel: "", maxPerOrder: 10, remaining: 0, soldOut: true, couponOnly: true },
      expect.objectContaining({ name: "C", soldOut: false, couponOnly: true }),
    ]);
  });

  it("checkout of a free ticket → paid immediately, answers snapshot, stats + orders", async () => {
    const { app } = await setup(kind);
    await enable(app);
    await app.fetch(
      send("POST", "/lp/tickets/fields", {
        fields: [
          { id: "role", label: "職種", type: "select", required: true, options: ["学生", "社会人"] },
          { id: "agree", label: "同意", type: "checkbox", required: true, options: [] },
        ],
      }),
    );
    const t = await addType(app, { name: "招待", priceJpy: 0, capacity: 5 });
    const coupon = await issueCoupon(app, t.id);
    const checkout = (b: Record<string, unknown>) => checkoutReq({ couponCode: coupon.code, ...b });

    const missing = await app.fetch(checkout({ ticketTypeId: t.id, answers: { role: "学生" } }));
    expect(missing.status).toBe(400);
    expect(JSON.stringify(await missing.json())).toContain("answers.agree");
    expect((await app.fetch(checkout({ ticketTypeId: t.id, answers: { role: "宇宙人", agree: "はい" } }))).status).toBe(400);
    expect((await app.fetch(checkout({ ticketTypeId: t.id, email: "bad", answers: { role: "学生", agree: "はい" } }))).status).toBe(400);
    expect((await app.fetch(checkout({ ticketTypeId: "nope", answers: { role: "学生", agree: "はい" } }))).status).toBe(400);

    const res = await app.fetch(checkout({ ticketTypeId: t.id, answers: { role: "学生", agree: "はい" } }));
    expect(res.status).toBe(200);
    const { redirectUrl } = await body<{ redirectUrl: string }>(res);
    expect(redirectUrl).toMatch(/^https:\/\/hokuriku-it-conf\.com\/tickets\/thanks\?order=tko_/);

    const s = await body<LpTicketsState>(await app.fetch(get("/lp/tickets")));
    expect(s.types[0]!.stats).toEqual({ sold: 1, pending: 0, revenueJpy: 0, remaining: 4 });
    expect(s.totals).toEqual({ sold: 1, revenueJpy: 0 });

    const orders = await body<LpTicketOrdersPage>(await app.fetch(get("/lp/tickets/orders")));
    expect(orders.items).toHaveLength(1);
    expect(orders.items[0]).toMatchObject({
      items: [{ ticketTypeId: t.id, ticketTypeName: "招待", dayLabel: "", unitPriceJpy: 0, quantity: 1 }],
      quantity: 1,
      amountJpy: 0,
      status: "paid",
      buyerName: "山田 太郎",
      buyerEmail: "taro@example.com",
      paidAt: NOW,
      couponId: coupon.id,
      answers: [
        { fieldId: "role", label: "職種", value: "学生" },
        { fieldId: "agree", label: "同意", value: "はい" },
      ],
    });
    const orderId = new URL(redirectUrl).searchParams.get("order");
    const confirmed = await app.fetch(send("POST", "/lp/internal/tickets/confirm", { orderId }, INTERNAL));
    expect(await confirmed.json()).toEqual({ status: "paid", summary: "招待 ×1" });
  });

  it("checkout disabled → 404; paid ticket without Stripe → 503; free still works", async () => {
    const { app } = await setup(kind);
    const paid = await addType(app, { name: "一般", priceJpy: 3000 });
    expect((await app.fetch(checkout({ ticketTypeId: paid.id }))).status).toBe(404);
    await enable(app);
    const res = await app.fetch(checkout({ ticketTypeId: paid.id }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "LP_PAYMENT_NOT_CONFIGURED" } });
    const free = await addType(app, { name: "招待", priceJpy: 0 });
    const code = (await issueCoupon(app, free.id)).code;
    expect((await app.fetch(checkout({ ticketTypeId: free.id, couponCode: code }))).status).toBe(200);
  });

  it("paid checkout calls Stripe with the server price; sold out → 409", async () => {
    const stripe = fakeStripe();
    const { app } = await setup(kind, { stripe });
    await enable(app);
    const t = await addType(app, { name: "一般", priceJpy: 3000, capacity: 1 });
    const res = await app.fetch(checkout({ ticketTypeId: t.id, priceJpy: 1, amount: 1 }));
    expect(res.status).toBe(200);
    expect((await body<{ redirectUrl: string }>(res)).redirectUrl).toBe("https://checkout.stripe.com/c/pay/cs_test_0");
    expect(stripe.calls).toHaveLength(1);
    const c = stripe.calls[0]!;
    expect(c.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(c.method).toBe("POST");
    expect(c.auth).toBe("Bearer sk_test_123");
    expect(Object.fromEntries(c.form!)).toMatchObject({
      mode: "payment",
      "line_items[0][price_data][currency]": "jpy",
      "line_items[0][price_data][unit_amount]": "3000",
      "line_items[0][price_data][product_data][name]": "一般",
      "line_items[0][quantity]": "1",
      customer_email: "taro@example.com",
      success_url: "https://hokuriku-it-conf.com/tickets/thanks?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://hokuriku-it-conf.com/tickets?canceled=1",
      locale: "ja",
      "payment_method_types[0]": "card",
    });
    const orderId = c.form!.get("client_reference_id");
    expect(c.form!.get("metadata[order_id]")).toBe(orderId);
    expect(Number(c.form!.get("expires_at")) - NOW_SEC).toBeGreaterThanOrEqual(1800);

    const s = await body<LpTicketsState>(await app.fetch(get("/lp/tickets")));
    expect(s.types[0]!.stats).toEqual({ sold: 0, pending: 1, revenueJpy: 0, remaining: 0 });

    const again = await app.fetch(checkout({ ticketTypeId: t.id }));
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: "LP_TICKET_SOLD_OUT", details: { ticketTypeId: t.id } } });
    expect(stripe.calls).toHaveLength(1);
  });

  it("one order buys several types x quantity: Stripe line items, stats count tickets, summary", async () => {
    const stripe = fakeStripe({ payment_status: "paid" });
    const { app } = await setup(kind, { stripe });
    await enable(app);
    const d1 = await addType(app, { name: "一般", priceJpy: 3000, dayLabel: "Day 1", capacity: 10 });
    const d2 = await addType(app, { name: "一般", priceJpy: 3000, dayLabel: "Day 2" });
    const res = await app.fetch(
      checkout({
        items: [
          { ticketTypeId: d1.id, quantity: 2 },
          { ticketTypeId: d2.id, quantity: 1 },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const form = Object.fromEntries(stripe.calls[0]!.form!);
    expect(form).toMatchObject({
      "line_items[0][price_data][unit_amount]": "3000",
      "line_items[0][price_data][product_data][name]": "一般（Day 1）",
      "line_items[0][quantity]": "2",
      "line_items[1][price_data][product_data][name]": "一般（Day 2）",
      "line_items[1][quantity]": "1",
    });
    expect(form["line_items[2][quantity]"]).toBeUndefined();

    let s = await body<LpTicketsState>(await app.fetch(get("/lp/tickets")));
    expect(s.types.map((t) => t.stats.pending)).toEqual([2, 1]);
    expect(s.types[0]!.stats.remaining).toBe(8);

    const confirmed = await app.fetch(send("POST", "/lp/internal/tickets/confirm", { sessionId: "cs_test_0" }, INTERNAL));
    expect(await confirmed.json()).toEqual({ status: "paid", summary: "一般 Day 1 ×2、一般 Day 2 ×1" });
    s = await body<LpTicketsState>(await app.fetch(get("/lp/tickets")));
    expect(s.totals).toEqual({ sold: 3, revenueJpy: 9000 });
    const orders = await body<LpTicketOrdersPage>(await app.fetch(get("/lp/tickets/orders")));
    expect(orders.items[0]).toMatchObject({ quantity: 3, amountJpy: 9000, status: "paid", couponId: null });
    expect(orders.items[0]!.items.map((i) => [i.dayLabel, i.quantity])).toEqual([
      ["Day 1", 2],
      ["Day 2", 1],
    ]);
  });

  it("items validation: empty, duplicate, over maxPerOrder, over 20 total, inactive", async () => {
    const { app } = await setup(kind, { stripe: fakeStripe() });
    await enable(app);
    const a = await addType(app, { name: "A", priceJpy: 1000, maxPerOrder: 2 });
    const b = await addType(app, { name: "B", priceJpy: 1000, maxPerOrder: 20 });
    const off = await addType(app, { name: "C", priceJpy: 1000 });
    await app.fetch(send("PATCH", `/lp/tickets/types/${off.id}`, { active: false }));
    const cases: [Record<string, unknown>, string][] = [
      [{ items: [] }, "items"],
      [{ items: [{ ticketTypeId: a.id, quantity: 1 }, { ticketTypeId: a.id, quantity: 1 }] }, `items.${a.id}`],
      [{ ticketTypeId: a.id, quantity: 0 }, `items.${a.id}`],
      [{ ticketTypeId: a.id, quantity: 3 }, `items.${a.id}`],
      [{ items: [{ ticketTypeId: a.id, quantity: 2 }, { ticketTypeId: b.id, quantity: 19 }] }, "items"],
      [{ ticketTypeId: off.id }, `items.${off.id}`],
    ];
    for (const [input, field] of cases) {
      const res = await app.fetch(checkout(input));
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain(field);
    }
    expect((await app.fetch(checkout({ ticketTypeId: a.id, quantity: 2 }))).status).toBe(200);
  });

  it("short on one type → 409 for that type and nothing stays held", async () => {
    const { app } = await setup(kind, { stripe: fakeStripe() });
    await enable(app);
    const a = await addType(app, { name: "A", priceJpy: 1000, capacity: 5 });
    const b = await addType(app, { name: "B", priceJpy: 1000, capacity: 2 });
    expect((await app.fetch(checkout({ ticketTypeId: b.id, quantity: 1 }))).status).toBe(200);
    const res = await app.fetch(
      checkout({ items: [{ ticketTypeId: a.id, quantity: 3 }, { ticketTypeId: b.id, quantity: 2 }] }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { details: { reason: "sold_out", ticketTypeId: b.id } } });
    const s = await body<LpTicketsState>(await app.fetch(get("/lp/tickets")));
    expect(s.types.map((t) => t.stats.remaining)).toEqual([5, 1]);
    expect((await body<LpTicketOrdersPage>(await app.fetch(get("/lp/tickets/orders")))).items).toHaveLength(1);
    expect((await app.fetch(checkout({ ticketTypeId: a.id, quantity: 5 }))).status).toBe(200);
  });

  it("stale pending (> 35 min) frees the seat", async () => {
    const { app, clock } = await setup(kind, { stripe: fakeStripe() });
    await enable(app);
    const t = await addType(app, { name: "一般", priceJpy: 3000, capacity: 1 });
    expect((await app.fetch(checkout({ ticketTypeId: t.id }))).status).toBe(200);
    clock.set("2026-10-07T03:36:00.000Z");
    expect((await app.fetch(checkout({ ticketTypeId: t.id }))).status).toBe(200);
  });

  it("daily checkout cap → 429", async () => {
    const { app } = await setup(kind, { cap: 2, stripe: fakeStripe() });
    await enable(app);
    const t = await addType(app, { name: "一般", priceJpy: 1000 });
    expect((await app.fetch(checkout({ ticketTypeId: t.id }))).status).toBe(200);
    expect((await app.fetch(checkout({ ticketTypeId: t.id }))).status).toBe(200);
    expect((await app.fetch(checkout({ ticketTypeId: t.id }))).status).toBe(429);
  });

  it("webhook: bad signature → 400; completed → paid; replay + expired after paid are no-ops", async () => {
    const stripe = fakeStripe();
    const { app } = await setup(kind, { stripe });
    await enable(app);
    const t = await addType(app, { name: "一般", priceJpy: 3000 });
    await app.fetch(checkout({ ticketTypeId: t.id }));
    const orderId = stripe.calls[0]!.form!.get("client_reference_id");
    const event = {
      id: "evt_1",
      type: "checkout.session.completed",
      data: { object: cs({ id: "cs_test_0", client_reference_id: orderId, payment_status: "paid", status: "complete", amount_total: 3000 }) },
    };

    const raw = JSON.stringify({ livemode: false, ...event });
    expect((await webhook(app, event, "t=1,v1=deadbeef")).status).toBe(400);
    expect((await webhook(app, event, await signStripePayload(raw, "whsec_other", NOW_SEC))).status).toBe(400);
    expect((await webhook(app, event, await signStripePayload(raw, WHSEC, NOW_SEC - 301))).status).toBe(400);
    let s = await body<LpTicketsState>(await app.fetch(get("/lp/tickets")));
    expect(s.types[0]!.stats.sold).toBe(0);

    const ok = await webhook(app, event);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ received: true });
    expect((await webhook(app, event)).status).toBe(200);
    expect(
      (await webhook(app, { id: "evt_2", type: "checkout.session.expired", data: { object: cs({ id: "cs_test_0", client_reference_id: orderId }) } }))
        .status,
    ).toBe(200);
    s = await body<LpTicketsState>(await app.fetch(get("/lp/tickets")));
    expect(s.types[0]!.stats).toMatchObject({ sold: 1, pending: 0, revenueJpy: 3000 });
    const orders = await body<LpTicketOrdersPage>(await app.fetch(get("/lp/tickets/orders")));
    expect(orders.items[0]).toMatchObject({ status: "paid", paidAt: NOW });
    expect((await webhook(app, { id: "evt_3", type: "customer.created", data: { object: {} } })).status).toBe(200);
  });

  it("webhook expired → order expired, seat released", async () => {
    const stripe = fakeStripe();
    const { app } = await setup(kind, { stripe });
    await enable(app);
    const t = await addType(app, { name: "一般", priceJpy: 3000, capacity: 1 });
    await app.fetch(checkout({ ticketTypeId: t.id }));
    const res = await webhook(app, { id: "evt_x", type: "checkout.session.expired", data: { object: cs({ id: "cs_test_0" }) } });
    expect(res.status).toBe(200);
    const s = await body<LpTicketsState>(await app.fetch(get("/lp/tickets")));
    expect(s.types[0]!.stats).toEqual({ sold: 0, pending: 0, revenueJpy: 0, remaining: 1 });
    expect((await app.fetch(send("POST", "/lp/internal/tickets/confirm", { sessionId: "cs_test_0" }, INTERNAL))).status).toBe(200);
  });

  it("webhook async payment: completed+unpaid stays pending; async_payment_succeeded → paid; failed → expired", async () => {
    const stripe = fakeStripe();
    const { app } = await setup(kind, { stripe });
    await enable(app);
    const t = await addType(app, { name: "一般", priceJpy: 3000 });
    await app.fetch(checkout({ ticketTypeId: t.id }));
    await app.fetch(checkout({ ticketTypeId: t.id }));
    const [a, b] = [0, 1].map((i) => stripe.calls[i]!.form!.get("client_reference_id"));
    const obj = (id: string, ref: string | null | undefined, ps: string) =>
      cs({ id, client_reference_id: ref, payment_status: ps, status: "complete", amount_total: 3000 });
    await webhook(app, { id: "e1", type: "checkout.session.completed", data: { object: obj("cs_test_0", a, "unpaid") } });
    let orders = await body<LpTicketOrdersPage>(await app.fetch(get("/lp/tickets/orders")));
    expect(orders.items.find((o) => o.id === a)!.status).toBe("pending");
    const ok = await webhook(app, {
      id: "e2",
      type: "checkout.session.async_payment_succeeded",
      data: { object: obj("cs_test_0", a, "paid") },
    });
    expect(ok.status).toBe(200);
    const failed = await webhook(app, {
      id: "e3",
      type: "checkout.session.async_payment_failed",
      data: { object: obj("cs_test_1", b, "unpaid") },
    });
    expect(failed.status).toBe(200);
    orders = await body<LpTicketOrdersPage>(await app.fetch(get("/lp/tickets/orders")));
    expect(orders.items.find((o) => o.id === a)!.status).toBe("paid");
    expect(orders.items.find((o) => o.id === b)!.status).toBe("expired");
  });

  it("confirm by orderId (free thanks page): paid; unknown id → unknown", async () => {
    const { app } = await setup(kind);
    await enable(app);
    const t = await addType(app, { name: "招待", priceJpy: 0 });
    const code = (await issueCoupon(app, t.id)).code;
    const { redirectUrl } = await body<{ redirectUrl: string }>(await app.fetch(checkout({ ticketTypeId: t.id, couponCode: code })));
    const orderId = new URL(redirectUrl).searchParams.get("order");
    const res = await app.fetch(send("POST", "/lp/internal/tickets/confirm", { orderId }, INTERNAL));
    expect(await res.json()).toEqual({ status: "paid", summary: "招待 ×1" });
    const unknown = await app.fetch(send("POST", "/lp/internal/tickets/confirm", { orderId: "tko_nope" }, INTERNAL));
    expect(await unknown.json()).toEqual({ status: "unknown" });
  });

  it("confirm: pending → asks Stripe → paid; unknown session → unknown", async () => {
    const stripe = fakeStripe({ payment_status: "paid" });
    const { app } = await setup(kind, { stripe });
    await enable(app);
    const t = await addType(app, { name: "一般", priceJpy: 3000 });
    await app.fetch(checkout({ ticketTypeId: t.id }));
    const res = await app.fetch(send("POST", "/lp/internal/tickets/confirm", { sessionId: "cs_test_0" }, INTERNAL));
    expect(await res.json()).toEqual({ status: "paid", summary: "一般 ×1" });
    expect(stripe.calls[1]).toMatchObject({ method: "GET", url: "https://api.stripe.com/v1/checkout/sessions/cs_test_0" });
    // already paid: no second Stripe call
    await app.fetch(send("POST", "/lp/internal/tickets/confirm", { sessionId: "cs_test_0" }, INTERNAL));
    expect(stripe.calls).toHaveLength(2);
    const unknown = await app.fetch(send("POST", "/lp/internal/tickets/confirm", { sessionId: "cs_nope" }, INTERNAL));
    expect(await unknown.json()).toEqual({ status: "unknown" });
    expect((await app.fetch(send("POST", "/lp/internal/tickets/confirm", {}, INTERNAL))).status).toBe(400);
  });

  it("confirm: Stripe still unpaid → pending", async () => {
    const stripe = fakeStripe({ payment_status: "unpaid", status: "open" });
    const { app } = await setup(kind, { stripe });
    await enable(app);
    const t = await addType(app, { name: "一般", priceJpy: 3000 });
    await app.fetch(checkout({ ticketTypeId: t.id }));
    const res = await app.fetch(send("POST", "/lp/internal/tickets/confirm", { sessionId: "cs_test_0" }, INTERNAL));
    expect(await res.json()).toEqual({ status: "pending", summary: "一般 ×1" });
  });

  it("orders: newest first with cursor paging", async () => {
    const { app, clock } = await setup(kind);
    await enable(app);
    const t = await addType(app, { name: "招待", priceJpy: 0 });
    const code = (await issueCoupon(app, t.id)).code;
    for (let i = 0; i < 3; i++) {
      clock.set(`2026-10-07T03:0${i}:00.000Z`);
      await app.fetch(checkout({ ticketTypeId: t.id, name: `n${i}`, couponCode: code }));
    }
    const p1 = await body<LpTicketOrdersPage>(await app.fetch(get("/lp/tickets/orders?limit=2")));
    expect(p1.items.map((o) => o.buyerName)).toEqual(["n2", "n1"]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await body<LpTicketOrdersPage>(
      await app.fetch(get(`/lp/tickets/orders?limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}`)),
    );
    expect(p2.items.map((o) => o.buyerName)).toEqual(["n0"]);
    expect(p2.nextCursor).toBeNull();
  });

  // ---- payment safety ----

  /** One paid-ticket order; returns its id (session = cs_test_<n>). */
  async function paidSetup(
    opts: { capacity?: number | null; stripe?: ReturnType<typeof fakeStripe>; deps?: Partial<AppDeps> } = {},
  ) {
    const stripe = opts.stripe ?? fakeStripe();
    const h = await setup(kind, { stripe, ...(opts.deps ? { deps: opts.deps } : {}) });
    await enable(h.app);
    const t = await addType(h.app, { name: "一般", priceJpy: 3000, capacity: opts.capacity ?? null });
    const buy = async () => {
      expect((await h.app.fetch(checkout({ ticketTypeId: t.id }))).status).toBe(200);
      const c = stripe.calls.filter((x) => x.method === "POST").at(-1)!;
      return c.form!.get("client_reference_id")!;
    };
    const stats = async () => (await body<LpTicketsState>(await h.app.fetch(get("/lp/tickets")))).types[0]!.stats;
    return { ...h, stripe, t, buy, stats };
  }
  const completed = (id: string, ref: string, o: Record<string, unknown> = {}) => ({
    id: `evt_${id}`,
    type: "checkout.session.completed",
    data: {
      object: cs({ id, client_reference_id: ref, payment_status: "paid", status: "complete", amount_total: 3000, payment_intent: `pi_${id}`, ...o }),
    },
  });

  it("checkout sends Idempotency-Key = checkout-<orderId>", async () => {
    const { stripe, buy } = await paidSetup();
    const orderId = await buy();
    expect(stripe.calls[0]!.idempotencyKey).toBe(`checkout-${orderId}`);
  });

  it("amount mismatch → needs_review (not paid), seat kept, no revenue", async () => {
    const { app, repo, buy, stats } = await paidSetup({ capacity: 1 });
    const id = await buy();
    expect((await webhook(app, completed("cs_test_0", id, { amount_total: 300 }))).status).toBe(200);
    expect(await repo.getOrder("hokuriku-it-conf.com", id)).toMatchObject({
      status: "needs_review",
      reviewReason: "amount_mismatch",
      paidAt: null,
      paymentIntentId: "pi_cs_test_0",
    });
    expect(await stats()).toEqual({ sold: 0, pending: 1, revenueJpy: 0, remaining: 0 });
    expect((await app.fetch(checkout({ ticketTypeId: (await repo.listTicketTypes("hokuriku-it-conf.com"))[0]!.id }))).status).toBe(409);
  });

  it("currency mismatch (confirm path) → needs_review", async () => {
    const { app, repo, buy } = await paidSetup({ stripe: fakeStripe({ currency: "usd" }) });
    const id = await buy();
    const res = await app.fetch(send("POST", "/lp/internal/tickets/confirm", { sessionId: "cs_test_0" }, INTERNAL));
    expect(await res.json()).toMatchObject({ status: "needs_review" });
    expect((await repo.getOrder("hokuriku-it-conf.com", id))!.reviewReason).toBe("currency_mismatch");
  });

  it("livemode mismatch is ignored: live event, live session object, live key vs test events", async () => {
    const { app, repo, buy } = await paidSetup();
    const id = await buy();
    expect(await (await webhook(app, { ...completed("cs_test_0", id), livemode: true })).json()).toEqual({ received: true });
    await webhook(app, completed("cs_test_0", id, { livemode: true }));
    expect((await repo.getOrder("hokuriku-it-conf.com", id))!.status).toBe("pending");

    const live = await paidSetup({ stripe: fakeStripe({}, { key: "sk_live_abc" }) });
    const liveId = await live.buy();
    expect((await webhook(live.app, completed("cs_test_0", liveId))).status).toBe(200);
    // confirm: the fake answers livemode=false to a live key → ignored too
    await live.app.fetch(send("POST", "/lp/internal/tickets/confirm", { sessionId: "cs_test_0" }, INTERNAL));
    expect((await live.repo.getOrder("hokuriku-it-conf.com", liveId))!.status).toBe("pending");
  });

  it("late paid wins over expired; paid never goes back to expired; duplicate webhook idempotent", async () => {
    const { app, repo, clock, buy } = await paidSetup();
    const id = await buy();
    await webhook(app, { id: "evt_exp", type: "checkout.session.expired", data: { object: cs({ id: "cs_test_0", client_reference_id: id }) } });
    expect((await repo.getOrder("hokuriku-it-conf.com", id))!.status).toBe("expired");

    await webhook(app, completed("cs_test_0", id));
    expect(await repo.getOrder("hokuriku-it-conf.com", id)).toMatchObject({ status: "paid", paidAt: NOW, paymentIntentId: "pi_cs_test_0" });

    clock.set("2026-10-07T03:10:00.000Z");
    await webhook(app, completed("cs_test_0", id));
    for (const type of ["checkout.session.expired", "checkout.session.async_payment_failed"]) {
      await webhook(app, { id: `evt_${type}`, type, data: { object: cs({ id: "cs_test_0", client_reference_id: id, payment_status: "unpaid" }) } });
    }
    expect(await repo.getOrder("hokuriku-it-conf.com", id)).toMatchObject({ status: "paid", paidAt: NOW });
  });

  it("late paid with no seat left → needs_review 'oversold' (money taken, seat kept)", async () => {
    const { app, repo, buy, stats } = await paidSetup({ capacity: 1 });
    const a = await buy();
    await webhook(app, { id: "evt_exp", type: "checkout.session.expired", data: { object: cs({ id: "cs_test_0", client_reference_id: a }) } });
    const b = await buy();
    await webhook(app, completed("cs_test_1", b));
    await webhook(app, completed("cs_test_0", a));
    expect(await repo.getOrder("hokuriku-it-conf.com", a)).toMatchObject({ status: "needs_review", reviewReason: "oversold", paidAt: NOW });
    expect((await repo.getOrder("hokuriku-it-conf.com", b))!.status).toBe("paid");
    expect(await stats()).toEqual({ sold: 1, pending: 1, revenueJpy: 3000, remaining: 0 });
  });

  it("reconcile: settles a paid session, expires session-less stale pending, survives a Stripe error", async () => {
    const stripe = fakeStripe({}, { failGet: new Set(["cs_test_0"]) });
    const { repo, clock, deps, buy, t } = await paidSetup({ stripe });
    const broken = await buy(); // 03:00, Stripe GET fails
    clock.set("2026-10-07T03:01:00.000Z");
    const good = await buy();
    const item = { ticketTypeId: t.id, ticketTypeName: "一般", dayLabel: "", unitPriceJpy: 3000, quantity: 1 };
    const orphan = {
      id: "tko_orphan",
      site: "hokuriku-it-conf.com",
      items: [item],
      quantity: 1,
      amountJpy: 3000,
      status: "pending" as const,
      buyerName: "x",
      buyerEmail: "x@example.com",
      answers: [],
      stripeSessionId: null,
      createdAt: "2026-10-07T03:02:00.000Z",
      paidAt: null,
      paymentIntentId: null,
      refundedAt: null,
      reviewReason: null,
      resolvedBy: null,
      resolvedAt: null,
      clientKey: null,
      couponId: null,
    };
    expect((await repo.insertOrderIfAvailable(orphan, new Map(), "2026-10-07T00:00:00.000Z")).ok).toBe(true);
    clock.set("2026-10-07T03:38:00.000Z");
    const fresh = await buy(); // too young to reconcile

    const sum = await new TicketService(deps).reconcile();
    expect(sum).toMatchObject({ checked: 2, paid: 1, errors: 1, sessionlessExpired: 1 });
    const status = async (id: string) => (await repo.getOrder("hokuriku-it-conf.com", id))!.status;
    expect(await status(broken)).toBe("pending");
    expect(await status(good)).toBe("paid");
    expect(await status("tko_orphan")).toBe("expired");
    expect(await status(fresh)).toBe("pending");
    expect(stripe.calls.some((c) => c.method === "GET" && c.url.endsWith("/cs_test_2"))).toBe(false);
  });

  it("charge.refunded: full → refunded + seat released; partial → stays paid", async () => {
    const { app, repo, buy, stats } = await paidSetup({ capacity: 2 });
    const a = await buy();
    const b = await buy();
    await webhook(app, completed("cs_test_0", a));
    await webhook(app, completed("cs_test_1", b));
    const refund = (pi: string, refunded: number) => ({
      id: `evt_r_${pi}_${refunded}`,
      type: "charge.refunded",
      data: { object: { id: `ch_${pi}`, payment_intent: pi, amount: 3000, amount_refunded: refunded, livemode: false } },
    });
    await webhook(app, refund("pi_cs_test_1", 1000));
    await webhook(app, refund("pi_cs_test_0", 3000));
    expect((await repo.getOrder("hokuriku-it-conf.com", a))).toMatchObject({ status: "refunded", refundedAt: NOW });
    expect((await repo.getOrder("hokuriku-it-conf.com", b))!.status).toBe("paid");
    expect(await stats()).toEqual({ sold: 1, pending: 0, revenueJpy: 3000, remaining: 1 });
    // refunded never comes back via a replayed session event
    await webhook(app, completed("cs_test_0", a));
    expect((await repo.getOrder("hokuriku-it-conf.com", a))!.status).toBe("refunded");
    await buy();
  });

  it("charge.dispute.created → needs_review", async () => {
    const { app, repo, buy } = await paidSetup();
    const a = await buy();
    await webhook(app, completed("cs_test_0", a));
    await webhook(app, {
      id: "evt_dp",
      type: "charge.dispute.created",
      data: { object: { id: "dp_1", charge: "ch_1", payment_intent: "pi_cs_test_0", livemode: false } },
    });
    expect(await repo.getOrder("hokuriku-it-conf.com", a)).toMatchObject({ status: "needs_review", reviewReason: "dispute" });
  });

  // ---- risk follow-ups: atomic late settle / approve / dispute close / backfill / per-sender cap ----

  it("two late payments for the last seat: exactly one paid, the other needs_review 'oversold'", async () => {
    const { app, repo, buy, stats } = await paidSetup({ capacity: 1 });
    const a = await buy();
    await webhook(app, { id: "evt_xa", type: "checkout.session.expired", data: { object: cs({ id: "cs_test_0", client_reference_id: a }) } });
    const b = await buy();
    await webhook(app, { id: "evt_xb", type: "checkout.session.expired", data: { object: cs({ id: "cs_test_1", client_reference_id: b }) } });
    await Promise.all([webhook(app, completed("cs_test_0", a)), webhook(app, completed("cs_test_1", b))]);
    const statuses = [(await repo.getOrder("hokuriku-it-conf.com", a))!, (await repo.getOrder("hokuriku-it-conf.com", b))!];
    expect(statuses.map((o) => o.status).sort()).toEqual(["needs_review", "paid"]);
    expect(statuses.find((o) => o.status === "needs_review")).toMatchObject({ reviewReason: "oversold", paidAt: NOW });
    expect(await stats()).toEqual({ sold: 1, pending: 1, revenueJpy: 3000, remaining: 0 });
  });

  it("approve: needs_review → paid by lp:publish; records who; 409 twice; 404 unknown; wire shows reviewReason", async () => {
    const { app, repo, buy, stats, clock } = await paidSetup({ capacity: 2 });
    const id = await buy();
    await webhook(app, completed("cs_test_0", id, { amount_total: 300 }));
    const listed = await body<LpTicketOrdersPage>(await app.fetch(get("/lp/tickets/orders")));
    expect(listed.items[0]).toMatchObject({ status: "needs_review", reviewReason: "amount_mismatch" });
    expect(listed.items[0]).not.toHaveProperty("clientKey");
    expect(listed.items[0]).not.toHaveProperty("resolvedBy");

    clock.set("2026-10-07T04:00:00.000Z");
    const res = await app.fetch(send("POST", `/lp/tickets/orders/${id}/approve`, {}));
    expect(res.status).toBe(200);
    expect(await body<LpTicketOrder>(res)).toMatchObject({ id, status: "paid", reviewReason: "amount_mismatch", paidAt: "2026-10-07T04:00:00.000Z" });
    expect(await repo.getOrder("hokuriku-it-conf.com", id)).toMatchObject({ resolvedBy: "usr_admin", resolvedAt: "2026-10-07T04:00:00.000Z" });
    expect(await stats()).toEqual({ sold: 1, pending: 0, revenueJpy: 3000, remaining: 1 });
    expect((await app.fetch(send("POST", `/lp/tickets/orders/${id}/approve`, {}))).status).toBe(409);
    expect((await app.fetch(send("POST", "/lp/tickets/orders/tko_nope/approve", {}))).status).toBe(404);
  });

  it("approve refuses an open dispute (Stripe decides it via dispute.closed)", async () => {
    const { app, repo, buy } = await paidSetup();
    const id = await buy();
    await webhook(app, completed("cs_test_0", id));
    await webhook(app, {
      id: "evt_dp",
      type: "charge.dispute.created",
      data: { object: { id: "dp_1", payment_intent: "pi_cs_test_0", livemode: false } },
    });
    expect((await app.fetch(send("POST", `/lp/tickets/orders/${id}/approve`, {}))).status).toBe(409);
    expect((await repo.getOrder("hokuriku-it-conf.com", id))!.status).toBe("needs_review");
  });

  it("approve needs lp:publish (edit alone is 403) and never touches pending / paid orders", async () => {
    const { app, repo, buy } = await paidSetup();
    const id = await buy();
    await webhook(app, completed("cs_test_0", id, { amount_total: 1 }));
    const editOnly = await makeApp(kind, "edit", 5000, null, [], { repo });
    expect((await editOnly.app.fetch(send("POST", `/lp/tickets/orders/${id}/approve`, {}))).status).toBe(403);
    expect((await repo.getOrder("hokuriku-it-conf.com", id))!.status).toBe("needs_review");

    const pending = await buy();
    expect((await app.fetch(send("POST", `/lp/tickets/orders/${pending}/approve`, {}))).status).toBe(409);
    expect((await repo.getOrder("hokuriku-it-conf.com", pending))!.status).toBe("pending");
  });

  it("charge.dispute.closed: lost → refunded (seat freed); won / warning_closed → paid; won never clears another reason", async () => {
    const { app, repo, buy, stats } = await paidSetup({ capacity: 3 });
    const ids = [await buy(), await buy(), await buy()];
    for (const [n, id] of ids.entries()) await webhook(app, completed(`cs_test_${n}`, id));
    const dispute = (n: number, type: string, status?: string) => ({
      id: `evt_${type}_${n}_${status ?? ""}`,
      type,
      data: { object: { id: `dp_${n}`, payment_intent: `pi_cs_test_${n}`, livemode: false, ...(status ? { status } : {}) } },
    });
    for (const n of [0, 1, 2]) await webhook(app, dispute(n, "charge.dispute.created"));
    await webhook(app, dispute(0, "charge.dispute.closed", "lost"));
    await webhook(app, dispute(1, "charge.dispute.closed", "won"));
    await webhook(app, dispute(2, "charge.dispute.closed", "warning_closed"));
    const o = async (i: number) => (await repo.getOrder("hokuriku-it-conf.com", ids[i]!))!;
    expect(await o(0)).toMatchObject({ status: "refunded", refundedAt: NOW });
    expect(await o(1)).toMatchObject({ status: "paid", resolvedBy: "stripe", reviewReason: "dispute" });
    expect((await o(2)).status).toBe("paid");
    expect(await stats()).toEqual({ sold: 2, pending: 0, revenueJpy: 6000, remaining: 1 });

    // an oversold order stays for a human even if an unrelated dispute is won
    const late = await paidSetup({ capacity: 1 });
    const a = await late.buy();
    await webhook(late.app, { id: "evt_xa", type: "checkout.session.expired", data: { object: cs({ id: "cs_test_0", client_reference_id: a }) } });
    const b = await late.buy();
    await webhook(late.app, completed("cs_test_1", b));
    await webhook(late.app, completed("cs_test_0", a));
    await webhook(late.app, dispute(0, "charge.dispute.closed", "won"));
    expect(await late.repo.getOrder("hokuriku-it-conf.com", a)).toMatchObject({ status: "needs_review", reviewReason: "oversold" });
  });

  it("reconcile backfills payment_intent_id of paid orders that lack it, so a later refund matches", async () => {
    const { app, repo, deps, buy, stripe } = await paidSetup();
    const id = await buy();
    await webhook(app, completed("cs_test_0", id, { payment_intent: null }));
    expect(await repo.getOrder("hokuriku-it-conf.com", id)).toMatchObject({ status: "paid", paymentIntentId: null });

    const sum = await new TicketService(deps).reconcile();
    expect(sum.paymentIntentBackfilled).toBe(1);
    expect((await repo.getOrder("hokuriku-it-conf.com", id))!.paymentIntentId).toBe("pi_cs_test_0");
    expect((await new TicketService(deps).reconcile()).paymentIntentBackfilled).toBe(0);
    // a live-mode session (other key mode) is never queried, so it cannot clog the batch
    const before = (await repo.getOrder("hokuriku-it-conf.com", id))!;
    await repo.insertOrderIfAvailable(
      { ...before, id: "tko_live", status: "paid", stripeSessionId: "cs_live_x", paymentIntentId: null },
      new Map(),
      NOW,
    );
    const gets = () => stripe.calls.filter((c) => c.url.endsWith("/cs_live_x")).length;
    await new TicketService(deps).reconcile();
    expect(gets()).toBe(0);

    await webhook(app, {
      id: "evt_ref",
      type: "charge.refunded",
      data: { object: { id: "ch_1", payment_intent: "pi_cs_test_0", amount: 3000, amount_refunded: 3000, livemode: false } },
    });
    expect((await repo.getOrder("hokuriku-it-conf.com", id))!.status).toBe("refunded");
  });

  it("per-sender hold cap: one sender holds at most 20 unpaid tickets; others / free / no key unaffected", async () => {
    const { app, t, clock } = await paidSetup();
    const free = await addType(app, { name: "招待", priceJpy: 0 });
    const code = (await issueCoupon(app, free.id)).code;
    const k1 = "a".repeat(32);
    const buy = (ticketTypeId: string, quantity: number, clientKey?: string) =>
      app.fetch(
        checkout({ ticketTypeId, quantity, ...(clientKey ? { clientKey } : {}), ...(ticketTypeId === free.id ? { couponCode: code } : {}) }),
      );
    expect((await buy(t.id, 10, k1)).status).toBe(200);
    expect((await buy(t.id, 10, k1)).status).toBe(200);
    expect((await buy(t.id, 1, k1)).status).toBe(429);
    expect((await buy(t.id, 1, "b".repeat(32))).status).toBe(200);
    expect((await buy(t.id, 1)).status).toBe(200);
    expect((await buy(t.id, 1, "NOT-A-HASH")).status).toBe(200);
    expect((await buy(free.id, 1, k1)).status).toBe(200);
    clock.set("2026-10-07T03:36:00.000Z"); // holds lapsed
    expect((await buy(t.id, 1, k1)).status).toBe(200);
  });

  it("checkout arms the reconcile alarm on paid orders only; an arm failure never fails the sale", async () => {
    let arms = 0;
    const ok = await paidSetup({ deps: { armReconcile: async () => void arms++ } });
    await ok.buy();
    const free = await addType(ok.app, { name: "招待", priceJpy: 0 });
    const code = (await issueCoupon(ok.app, free.id)).code;
    expect((await ok.app.fetch(checkout({ ticketTypeId: free.id, couponCode: code }))).status).toBe(200);
    expect(arms).toBe(1);

    // a verified webhook arms it too (refunds on old orders before the next sale); an unsigned one does not
    await webhook(ok.app, { id: "evt_other", type: "payment_intent.created", data: { object: {} } });
    expect(arms).toBe(1);
    await webhook(ok.app, completed("cs_test_0", "tko_unknown"));
    expect(arms).toBe(2);
    expect((await webhook(ok.app, completed("cs_test_0", "x"), "t=1,v1=bad")).status).toBe(400);
    expect(arms).toBe(2);

    const failing = await paidSetup({ deps: { armReconcile: async () => Promise.reject(new Error("do down")) } });
    await failing.buy();
    expect((await webhook(failing.app, completed("cs_test_0", "tko_unknown"))).status).toBe(200);
  });

  // ---- coupons (無料券) ----

  it("coupon admin: issue needs lp:publish, list needs edit; validation; server-generated code", async () => {
    const noPublish = await setup(kind, { publish: false });
    const t0 = await addType(noPublish.app, { name: "招待", priceJpy: 0 });
    expect((await noPublish.app.fetch(send("POST", "/lp/tickets/coupons", { ticketTypeId: t0.id, maxUses: 1 }))).status).toBe(403);
    expect((await noPublish.app.fetch(send("PATCH", "/lp/tickets/coupons/x", { active: false }))).status).toBe(403);
    expect((await noPublish.app.fetch(get("/lp/tickets/coupons"))).status).toBe(200);

    const { app } = await setup(kind);
    const t = await addType(app, { name: "招待", priceJpy: 0 });
    const bad: [Record<string, unknown>, string][] = [
      [{ maxUses: 1 }, "ticketTypeId"],
      [{ ticketTypeId: "nope", maxUses: 1 }, "ticketTypeId"],
      [{ ticketTypeId: t.id, maxUses: 0 }, "maxUses"],
      [{ ticketTypeId: t.id, maxUses: 1001 }, "maxUses"],
      [{ ticketTypeId: t.id, maxUses: 1.5 }, "maxUses"],
      [{ ticketTypeId: t.id, maxUses: 1, label: "x".repeat(61) }, "label"],
      [{ ticketTypeId: t.id, maxUses: 1, expiresAt: "2026-10-07T02:59:00.000Z" }, "expiresAt"],
      [{ ticketTypeId: t.id, maxUses: 1, expiresAt: "someday" }, "expiresAt"],
    ];
    for (const [input, field] of bad) {
      const res = await app.fetch(send("POST", "/lp/tickets/coupons", input));
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain(field);
    }
    // a client-chosen code is ignored: codes are always generated
    const c = await issueCoupon(app, t.id, 5, { label: " 登壇者 ", code: "EASY", expiresAt: "2026-11-01T00:00:00+09:00" });
    expect(c.code).toMatch(/^[A-HJKMNP-Z2-9]{10}$/);
    expect(c).toMatchObject({ label: "登壇者", ticketTypeId: t.id, maxUses: 5, used: 0, active: true, createdBy: "usr_admin", expiresAt: "2026-10-31T15:00:00.000Z" });
    const c2 = await issueCoupon(app, t.id, 1);
    expect(c2.code).not.toBe(c.code);
    const list = await body<LpTicketCouponsPage>(await app.fetch(get("/lp/tickets/coupons")));
    expect(list.items.map((x) => x.id)).toEqual([c2.id, c.id]);
    expect((await app.fetch(send("PATCH", "/lp/tickets/coupons/nope", { active: false }))).status).toBe(404);
    expect((await app.fetch(send("PATCH", `/lp/tickets/coupons/${c.id}`, {}))).status).toBe(400);
  });

  it("a 0-yen type needs a coupon; bad codes get one uniform 400; codes are normalized", async () => {
    const { app } = await setup(kind);
    await enable(app);
    const t = await addType(app, { name: "招待", priceJpy: 0 });
    const res = await app.fetch(checkout({ ticketTypeId: t.id }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("coupon_required");
    for (const couponCode of ["NOPE2345AB", "!!", "x".repeat(40)]) {
      const r = await app.fetch(checkout({ ticketTypeId: t.id, couponCode }));
      expect(r.status).toBe(400);
      expect(JSON.stringify(await r.json())).toContain("couponCode");
    }
    const c = await issueCoupon(app, t.id);
    const messy = ` ${c.code.slice(0, 5).toLowerCase()}-${c.code.slice(5)} `;
    expect((await app.fetch(checkout({ ticketTypeId: t.id, couponCode: messy }))).status).toBe(200);
    // an empty coupon field is "no coupon", not an invalid one
    expect(JSON.stringify(await (await app.fetch(checkout({ ticketTypeId: t.id, couponCode: "  " }))).json())).toContain("coupon_required");
  });

  it("a coupon on a paid type makes that order 0 yen: paid at once, Stripe never called, seat taken, no revenue", async () => {
    const stripe = fakeStripe();
    const { app } = await setup(kind, { stripe });
    await enable(app);
    const t = await addType(app, { name: "一般", priceJpy: 3000, capacity: 3 });
    const c = await issueCoupon(app, t.id, 2);
    const res = await app.fetch(checkout({ ticketTypeId: t.id, quantity: 2, couponCode: c.code }));
    expect(res.status).toBe(200);
    expect((await body<{ redirectUrl: string }>(res)).redirectUrl).toContain("/tickets/thanks?order=");
    expect(stripe.calls).toHaveLength(0);
    const s = await body<LpTicketsState>(await app.fetch(get("/lp/tickets")));
    expect(s.types[0]!.stats).toEqual({ sold: 2, pending: 0, revenueJpy: 0, remaining: 1 });
    const orders = await body<LpTicketOrdersPage>(await app.fetch(get("/lp/tickets/orders")));
    expect(orders.items[0]).toMatchObject({ amountJpy: 0, status: "paid", couponId: c.id, items: [{ unitPriceJpy: 0, quantity: 2 }] });
    // without the coupon the same type still goes through Stripe at the server price
    expect((await app.fetch(checkout({ ticketTypeId: t.id }))).status).toBe(200);
    expect(stripe.calls[0]!.form!.get("line_items[0][price_data][unit_amount]")).toBe("3000");
  });

  it("a coupon order is exactly the coupon's type: other / extra items → 400 not_applicable", async () => {
    const { app } = await setup(kind, { stripe: fakeStripe() });
    await enable(app);
    const free = await addType(app, { name: "招待", priceJpy: 0 });
    const paid = await addType(app, { name: "一般", priceJpy: 3000 });
    const c = await issueCoupon(app, free.id);
    for (const input of [
      { ticketTypeId: paid.id, couponCode: c.code },
      { items: [{ ticketTypeId: free.id, quantity: 1 }, { ticketTypeId: paid.id, quantity: 1 }], couponCode: c.code },
    ]) {
      const res = await app.fetch(checkout(input));
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("not_applicable");
    }
    expect((await body<LpTicketOrdersPage>(await app.fetch(get("/lp/tickets/orders")))).items).toHaveLength(0);
  });

  it("maxUses counts tickets: over the rest → 409 coupon_used_up; used shows in the list; check endpoint agrees", async () => {
    const { app } = await setup(kind);
    await enable(app);
    const t = await addType(app, { name: "招待", priceJpy: 0 });
    const c = await issueCoupon(app, t.id, 3);
    const check = () => app.fetch(send("POST", "/lp/internal/tickets/coupon", { code: c.code }, INTERNAL));
    expect(await (await check()).json()).toEqual({ ticketTypeId: t.id, remainingUses: 3 });
    expect((await app.fetch(checkout({ ticketTypeId: t.id, quantity: 2, couponCode: c.code }))).status).toBe(200);
    const over = await app.fetch(checkout({ ticketTypeId: t.id, quantity: 2, couponCode: c.code }));
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ error: { code: "LP_TICKET_COUPON_USED_UP", details: { reason: "coupon_used_up" } } });
    expect(await (await check()).json()).toEqual({ ticketTypeId: t.id, remainingUses: 1 });
    expect((await app.fetch(checkout({ ticketTypeId: t.id, quantity: 1, couponCode: c.code }))).status).toBe(200);
    expect((await app.fetch(checkout({ ticketTypeId: t.id, quantity: 1, couponCode: c.code }))).status).toBe(409);
    expect((await check()).status).toBe(409);
    const list = await body<LpTicketCouponsPage>(await app.fetch(get("/lp/tickets/coupons")));
    expect(list.items[0]).toMatchObject({ used: 3, maxUses: 3 });
    expect((await body<LpTicketOrdersPage>(await app.fetch(get("/lp/tickets/orders")))).items).toHaveLength(2);
  });

  it("concurrent checkouts for the last use: exactly one gets it", async () => {
    const { app } = await setup(kind);
    await enable(app);
    const t = await addType(app, { name: "招待", priceJpy: 0 });
    const c = await issueCoupon(app, t.id, 1);
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => app.fetch(checkout({ ticketTypeId: t.id, couponCode: c.code, name: `n${i}` }))),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
    expect((await body<LpTicketOrdersPage>(await app.fetch(get("/lp/tickets/orders")))).items).toHaveLength(1);
  });

  it("sold out with a valid coupon → 409 sold_out and the use is not consumed", async () => {
    const { app } = await setup(kind);
    await enable(app);
    const t = await addType(app, { name: "招待", priceJpy: 0, capacity: 1 });
    const c = await issueCoupon(app, t.id, 5);
    const res = await app.fetch(checkout({ ticketTypeId: t.id, quantity: 2, couponCode: c.code }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { details: { reason: "sold_out" } } });
    expect((await body<LpTicketCouponsPage>(await app.fetch(get("/lp/tickets/coupons")))).items[0]!.used).toBe(0);
    expect((await app.fetch(checkout({ ticketTypeId: t.id, quantity: 1, couponCode: c.code }))).status).toBe(200);
  });

  it("paused coupon / expired coupon / paused type → invalid; resuming brings it back", async () => {
    const { app, clock } = await setup(kind);
    await enable(app);
    const t = await addType(app, { name: "招待", priceJpy: 0 });
    const c = await issueCoupon(app, t.id, 10, { expiresAt: "2026-10-07T04:00:00.000Z" });
    const buy = () => app.fetch(checkout({ ticketTypeId: t.id, couponCode: c.code }));
    const paused = await app.fetch(send("PATCH", `/lp/tickets/coupons/${c.id}`, { active: false }));
    expect(await paused.json()).toMatchObject({ active: false });
    expect((await buy()).status).toBe(400);
    expect((await app.fetch(send("POST", "/lp/internal/tickets/coupon", { code: c.code }, INTERNAL))).status).toBe(400);
    await app.fetch(send("PATCH", `/lp/tickets/coupons/${c.id}`, { active: true }));
    expect((await buy()).status).toBe(200);
    await app.fetch(send("PATCH", `/lp/tickets/types/${t.id}`, { active: false }));
    expect((await buy()).status).toBe(400);
    await app.fetch(send("PATCH", `/lp/tickets/types/${t.id}`, { active: true }));
    clock.set("2026-10-07T04:00:00.000Z");
    expect((await buy()).status).toBe(400);
  });

  it("repo guard: a coupon insert past max_uses / paused / expired is refused inside the same write", async () => {
    const { app, repo } = await setup(kind);
    const t = await addType(app, { name: "招待", priceJpy: 0 });
    const c = await issueCoupon(app, t.id, 1, { expiresAt: "2026-10-08T00:00:00.000Z" });
    const order = (id: string, createdAt = NOW) => ({
      id,
      site: "hokuriku-it-conf.com",
      items: [{ ticketTypeId: t.id, ticketTypeName: "招待", dayLabel: "", unitPriceJpy: 0, quantity: 1 }],
      quantity: 1,
      amountJpy: 0,
      status: "paid" as const,
      buyerName: "x",
      buyerEmail: "x@example.com",
      answers: [],
      stripeSessionId: null,
      createdAt,
      paidAt: createdAt,
      paymentIntentId: null,
      refundedAt: null,
      reviewReason: null,
      resolvedBy: null,
      resolvedAt: null,
      clientKey: null,
      couponId: c.id,
    });
    const since = "2026-10-07T00:00:00.000Z";
    expect(await repo.insertOrderIfAvailable(order("o1"), new Map(), since)).toEqual({ ok: true });
    expect(await repo.insertOrderIfAvailable(order("o2"), new Map(), since)).toEqual({ ok: false, reason: "coupon_used_up" });
    expect(await repo.getOrder("hokuriku-it-conf.com", "o2")).toBeNull();
    const c2 = await issueCoupon(app, t.id, 5, { expiresAt: "2026-10-08T00:00:00.000Z" });
    const o3 = { ...order("o3", "2026-10-08T00:00:00.000Z"), couponId: c2.id };
    expect(await repo.insertOrderIfAvailable(o3, new Map(), since)).toEqual({ ok: false, reason: "coupon_used_up" });
    await repo.setCouponActive("hokuriku-it-conf.com", c2.id, false, NOW);
    expect(await repo.insertOrderIfAvailable({ ...order("o4"), couponId: c2.id }, new Map(), since)).toEqual({ ok: false, reason: "coupon_used_up" });
    expect(await repo.insertOrderIfAvailable({ ...order("o5"), couponId: "tkc_missing" }, new Map(), since)).toEqual({ ok: false, reason: "coupon_used_up" });
  });

  it("check endpoint: sales off → 404; internal only", async () => {
    const { app } = await setup(kind);
    const t = await addType(app, { name: "招待", priceJpy: 0 });
    const c = await issueCoupon(app, t.id);
    expect((await app.fetch(send("POST", "/lp/internal/tickets/coupon", { code: c.code }, INTERNAL))).status).toBe(404);
    await enable(app);
    expect((await app.fetch(send("POST", "/lp/internal/tickets/coupon", { code: c.code }))).status).toBe(404);
    expect((await app.fetch(send("POST", "/lp/internal/tickets/coupon", { code: c.code }, INTERNAL))).status).toBe(200);
  });

  it("session id not stored → no payment URL leaves the service (nobody can pay that session)", async () => {
    const { app, repo, t } = await paidSetup();
    repo.setOrderSession = async () => {
      throw new Error("d1 down");
    };
    const res = await app.fetch(checkout({ ticketTypeId: t.id }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("checkout.stripe.com");
  });
});

describe("stripeFrom", () => {
  it("needs BOTH secrets; mode follows the key", () => {
    expect(stripeFrom({ STRIPE_SECRET_KEY: "sk_test_1" })).toBeNull();
    expect(stripeFrom({ STRIPE_WEBHOOK_SECRET: "whsec_1" })).toBeNull();
    expect(stripeFrom({ STRIPE_SECRET_KEY: "sk_test_1", STRIPE_WEBHOOK_SECRET: "whsec_1" })!.livemode).toBe(false);
    expect(stripeFrom({ STRIPE_SECRET_KEY: "sk_live_1", STRIPE_WEBHOOK_SECRET: "whsec_1" })!.livemode).toBe(true);
  });
});

describe("tickets gate", () => {
  it("view can read state but not orders / edits; none cannot read", async () => {
    const view = await makeApp("memory", "view");
    expect((await view.app.fetch(get("/lp/tickets"))).status).toBe(200);
    expect((await view.app.fetch(get("/lp/tickets/orders"))).status).toBe(403);
    expect((await view.app.fetch(send("POST", "/lp/tickets/types", { name: "a", priceJpy: 0 }))).status).toBe(403);
    expect((await view.app.fetch(send("POST", "/lp/tickets/fields", { fields: [] }))).status).toBe(403);
    expect((await view.app.fetch(send("POST", "/lp/tickets/cta", { enabled: true }))).status).toBe(403);
    const none = await makeApp("memory", "none");
    expect((await none.app.fetch(get("/lp/tickets"))).status).toBe(403);
  });

  it("internal routes are 404 without x-dub-internal", async () => {
    const { app } = await makeApp("memory");
    expect((await app.fetch(send("POST", "/lp/internal/tickets/checkout", {}, {}))).status).toBe(404);
    expect((await app.fetch(send("POST", "/lp/internal/tickets/stripe-webhook", {}, {}))).status).toBe(404);
  });
});
