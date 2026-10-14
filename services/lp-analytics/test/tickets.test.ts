// LP チケット購入: LP管理 API (/lp/tickets*) + 公開 LP Worker 向け内部 API (/lp/internal/tickets*).
import { describe, it, expect } from "vitest";
import { createStripeClient, signStripePayload } from "../src/stripe";
import type { LpTicketOrdersPage, LpTicketsState, LpTicketTypeSummary } from "../src/types";
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
  form: URLSearchParams | null;
}

function fakeStripe(session: { payment_status?: string; status?: string } = {}) {
  const calls: StripeCall[] = [];
  let n = 0;
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method,
      auth: headers.get("authorization"),
      form: typeof init?.body === "string" ? new URLSearchParams(init.body) : null,
    });
    if (method === "POST") {
      const id = `cs_test_${n++}`;
      const form = new URLSearchParams(init?.body as string);
      return Response.json({
        id,
        url: `https://checkout.stripe.com/c/pay/${id}`,
        status: "open",
        payment_status: "unpaid",
        client_reference_id: form.get("client_reference_id"),
      });
    }
    const id = url.split("/").pop()!;
    return Response.json({ id, status: session.status ?? "complete", payment_status: session.payment_status ?? "paid" });
  };
  return { calls, client: createStripeClient("sk_test_123", fetchFn) };
}

async function setup(
  kind: RepoKind,
  opts: { stripe?: ReturnType<typeof fakeStripe> | null; cap?: number; publish?: boolean } = {},
) {
  const h = await makeApp(kind, "edit", 5000, null, opts.publish === false ? [] : ["lp:publish"], {
    stripe: opts.stripe ? opts.stripe.client : null,
    stripeWebhookSecret: WHSEC,
    ...(opts.cap !== undefined ? { dailyCheckoutCap: opts.cap } : {}),
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

async function enable(app: App) {
  expect((await app.fetch(send("POST", "/lp/tickets/enabled", { enabled: true }))).status).toBe(200);
}

/** `ticketTypeId` (+ `quantity`) is shorthand for a one-line `items`. */
const checkout = ({ ticketTypeId, quantity, ...b }: Record<string, unknown>) =>
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

async function webhook(app: App, event: unknown, sig?: string) {
  const raw = JSON.stringify(event);
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
      previewEnabled: false,
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

  it("preview toggle needs edit only, never opens sales or checkout", async () => {
    const view = await makeApp(kind, "view");
    expect((await view.app.fetch(send("POST", "/lp/tickets/preview", { enabled: true }))).status).toBe(403);
    const { app } = await setup(kind, { publish: false });
    expect((await app.fetch(send("POST", "/lp/tickets/preview", { enabled: "on" }))).status).toBe(400);
    const free = await addType(app, { name: "招待", priceJpy: 0 });
    const res = await app.fetch(send("POST", "/lp/tickets/preview", { enabled: true }));
    expect(res.status).toBe(200);
    expect(await body<LpTicketsState>(res)).toMatchObject({ enabled: false, previewEnabled: true, updatedBy: "usr_admin" });
    const internal = await body<{ enabled: boolean; previewEnabled: boolean }>(await app.fetch(get("/lp/internal/tickets", INTERNAL)));
    expect(internal).toMatchObject({ enabled: false, previewEnabled: true });
    expect((await app.fetch(checkout({ ticketTypeId: free.id }))).status).toBe(404);
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
    expect((await app.fetch(checkout({ ticketTypeId: a.id }))).status).toBe(200);

    expect((await app.fetch(get("/lp/internal/tickets", {}))).status).toBe(404);
    const res = await body<{ enabled: boolean; paymentReady: boolean; types: { name: string; soldOut: boolean }[] }>(
      await app.fetch(get("/lp/internal/tickets", INTERNAL)),
    );
    expect(res.enabled).toBe(true);
    expect(res.paymentReady).toBe(false);
    expect(res.types).toEqual([
      { id: a.id, name: "A", description: "", priceJpy: 0, dayLabel: "", maxPerOrder: 10, remaining: 0, soldOut: true },
      expect.objectContaining({ name: "C", soldOut: false }),
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
    expect((await app.fetch(checkout({ ticketTypeId: free.id }))).status).toBe(200);
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
    const inv = await addType(app, { name: "招待", priceJpy: 0 });
    const res = await app.fetch(
      checkout({
        items: [
          { ticketTypeId: d1.id, quantity: 2 },
          { ticketTypeId: d2.id, quantity: 1 },
          { ticketTypeId: inv.id, quantity: 1 },
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
    expect(form["line_items[2][quantity]"]).toBeUndefined(); // free line is not sent to Stripe

    let s = await body<LpTicketsState>(await app.fetch(get("/lp/tickets")));
    expect(s.types.map((t) => t.stats.pending)).toEqual([2, 1, 1]);
    expect(s.types[0]!.stats.remaining).toBe(8);

    const confirmed = await app.fetch(send("POST", "/lp/internal/tickets/confirm", { sessionId: "cs_test_0" }, INTERNAL));
    expect(await confirmed.json()).toEqual({ status: "paid", summary: "一般 Day 1 ×2、一般 Day 2 ×1、招待 ×1" });
    s = await body<LpTicketsState>(await app.fetch(get("/lp/tickets")));
    expect(s.totals).toEqual({ sold: 4, revenueJpy: 9000 });
    const orders = await body<LpTicketOrdersPage>(await app.fetch(get("/lp/tickets/orders")));
    expect(orders.items[0]).toMatchObject({ quantity: 4, amountJpy: 9000, status: "paid" });
    expect(orders.items[0]!.items.map((i) => [i.dayLabel, i.quantity])).toEqual([
      ["Day 1", 2],
      ["Day 2", 1],
      ["", 1],
    ]);
  });

  it("items validation: empty, duplicate, over maxPerOrder, over 20 total, inactive", async () => {
    const { app } = await setup(kind);
    await enable(app);
    const a = await addType(app, { name: "A", priceJpy: 0, maxPerOrder: 2 });
    const b = await addType(app, { name: "B", priceJpy: 0, maxPerOrder: 20 });
    const off = await addType(app, { name: "C", priceJpy: 0 });
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
    const { app } = await setup(kind);
    await enable(app);
    const a = await addType(app, { name: "A", priceJpy: 0, capacity: 5 });
    const b = await addType(app, { name: "B", priceJpy: 0, capacity: 2 });
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
    const { app } = await setup(kind, { cap: 2 });
    await enable(app);
    const t = await addType(app, { name: "招待", priceJpy: 0 });
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
      data: { object: { id: "cs_test_0", client_reference_id: orderId, payment_status: "paid", status: "complete" } },
    };

    expect((await webhook(app, event, "t=1,v1=deadbeef")).status).toBe(400);
    expect((await webhook(app, event, await signStripePayload(JSON.stringify(event), "whsec_other", NOW_SEC))).status).toBe(400);
    expect((await webhook(app, event, await signStripePayload(JSON.stringify(event), WHSEC, NOW_SEC - 301))).status).toBe(400);
    let s = await body<LpTicketsState>(await app.fetch(get("/lp/tickets")));
    expect(s.types[0]!.stats.sold).toBe(0);

    const ok = await webhook(app, event);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ received: true });
    expect((await webhook(app, event)).status).toBe(200);
    expect(
      (await webhook(app, { id: "evt_2", type: "checkout.session.expired", data: { object: { id: "cs_test_0", client_reference_id: orderId } } }))
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
    const res = await webhook(app, { id: "evt_x", type: "checkout.session.expired", data: { object: { id: "cs_test_0" } } });
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
    const obj = (id: string, ref: string | null | undefined, ps: string) => ({
      id,
      client_reference_id: ref,
      payment_status: ps,
      status: "complete",
    });
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
    const { redirectUrl } = await body<{ redirectUrl: string }>(await app.fetch(checkout({ ticketTypeId: t.id })));
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
    for (let i = 0; i < 3; i++) {
      clock.set(`2026-10-07T03:0${i}:00.000Z`);
      await app.fetch(checkout({ ticketTypeId: t.id, name: `n${i}` }));
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
