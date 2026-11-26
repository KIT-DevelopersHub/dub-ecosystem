// 領収書: 注文ごとの署名トークン・宛名（購入時 / 後から 1 回）・有料で支払い済み・返金済みだけ・メールのリンク。
import { describe, it, expect } from "vitest";
import { lpTickets } from "@dub/types";
import { TicketDelivery } from "../src/delivery";
import type { OutboundMail } from "../src/mailer";
import { createStripeClient } from "../src/stripe";
import { renderBuyerMail } from "../src/ticket-mail";
import { RECEIPT_ISSUER, receiptOf, taxIncluded } from "../src/ticket-receipt";
import { receiptToken, ticketToken, verifyReceiptToken, verifyTicketToken } from "../src/ticket-token";
import type { LpTicketReceipt, TicketOrderRow } from "../src/types";
import { get, makeApp, send, type RepoKind } from "./harness";

const SITE = "hokuriku-it-conf.com";
const SECRET = "harness-secret";
const INTERNAL = { "x-dub-internal": "1" };
const NOW = "2026-10-07T03:00:00.000Z";

/** Stripe that only creates sessions (payment is settled through the repo in these tests). */
function sessionOnlyStripe() {
  let n = 0;
  return createStripeClient("sk_live_abc", async () => {
    const id = `cs_live_${n++}`;
    return Response.json({ id, url: `https://checkout.stripe.com/${id}`, status: "open", payment_status: "unpaid", livemode: true });
  });
}

async function setup(kind: RepoKind) {
  const sent: OutboundMail[] = [];
  const deferred: Promise<unknown>[] = [];
  const h = await makeApp(kind, "edit", ["lp:publish"], {
    stripe: sessionOnlyStripe(),
    stripeWebhookSecret: "whsec_test",
    mailer: { send: async (mail) => (sent.push(mail), { ok: true, id: "re_1" }) },
    defer: (p) => void deferred.push(p),
  });
  h.clock.set(NOW);
  const create = async (priceJpy: number) =>
    (await (await h.app.fetch(send("POST", "/lp/tickets/types", { name: priceJpy ? "一般" : "招待", description: "", priceJpy, capacity: null, active: true, dayLabel: "Day 1" }))).json()) as { id: string };
  const paidType = await create(3000);
  await h.app.fetch(send("POST", "/lp/tickets/enabled", { enabled: true }));
  const checkout = (b: Record<string, unknown>) =>
    h.app.fetch(
      send("POST", "/lp/internal/tickets/checkout", { name: "山田 太郎", email: "taro@example.com", answers: {}, origin: `https://${SITE}`, items: [{ ticketTypeId: paidType.id, quantity: 2 }], ...b }, INTERNAL),
    );
  const latest = async () => (await h.repo.listOrders(SITE, null, 1))[0]!;
  /** A paid 2 x 3000 order. */
  const buy = async (b: Record<string, unknown> = {}): Promise<TicketOrderRow> => {
    expect((await checkout(b)).status).toBe(200);
    const o = await latest();
    expect(await h.repo.markOrderPaid(o.id, { paidAt: NOW, sessionId: o.stripeSessionId, paymentIntentId: `pi_${o.id}` })).toBe("paid");
    return (await h.repo.getOrder(SITE, o.id))!;
  };
  const free = async (): Promise<TicketOrderRow> => {
    const t = await create(0);
    const c = (await (await h.app.fetch(send("POST", "/lp/tickets/coupons", { ticketTypeId: t.id, maxUses: 10 }))).json()) as { code: string };
    expect((await checkout({ items: [{ ticketTypeId: t.id, quantity: 1 }], couponCode: c.code })).status).toBe(200);
    return latest();
  };
  const receipt = async (token: string) => h.app.fetch(get(`/lp/internal/tickets/receipt/${token}`, INTERNAL));
  const setName = async (token: string, body: unknown) => h.app.fetch(send("POST", `/lp/internal/tickets/receipt/${token}`, body, INTERNAL));
  const flush = async () => void (await Promise.all(deferred.splice(0)));
  return { ...h, sent, checkout, buy, free, receipt, setName, flush, token: (id: string) => receiptToken(SECRET, id) };
}

describe("receipt token", () => {
  it("round-trips, and is not interchangeable with a ticket token", async () => {
    const r = await receiptToken(SECRET, "tko_01ABC");
    expect(await verifyReceiptToken(SECRET, r)).toBe("tko_01ABC");
    expect(await verifyReceiptToken("other-secret", r)).toBeNull();
    // A ticket URL forwarded to a companion must not open the receipt (and vice versa).
    expect(await verifyReceiptToken(SECRET, await ticketToken(SECRET, "tko_01ABC"))).toBeNull();
    expect(await verifyTicketToken(SECRET, r)).toBeNull();
    expect(await verifyReceiptToken(null, r)).toBeNull();
    expect(await verifyReceiptToken(SECRET, "tko_01ABC.short")).toBeNull();
  });
});

describe("receiptOf", () => {
  const base = {
    id: "tko_000000000ABCDEFGH",
    items: [{ ticketTypeId: "t", ticketTypeName: "一般", dayLabel: "Day 1", unitPriceJpy: 3000, quantity: 2 }],
    amountJpy: 6000,
    status: "paid",
    paidAt: NOW,
    paymentMethod: "card",
    preview: false,
    stripeSessionId: "cs_live_1",
    receiptName: "株式会社テスト",
  } as unknown as TicketOrderRow;

  it("only for paid / refunded orders with an amount", () => {
    expect(receiptOf(base)).toMatchObject({ orderNumber: "ABCDEFGH", status: "issued", amountJpy: 6000, receiptName: "株式会社テスト", test: false, taxJpy: null });
    expect(receiptOf({ ...base, status: "refunded" })?.status).toBe("refunded");
    for (const status of ["pending", "expired", "needs_review"] as const) expect(receiptOf({ ...base, status })).toBeNull();
    expect(receiptOf({ ...base, amountJpy: 0 })).toBeNull();
    expect(receiptOf({ ...base, paidAt: null })).toBeNull();
    expect(receiptOf({ ...base, stripeSessionId: "cs_test_1" })?.test).toBe(true);
  });

  it("states tax only with an invoice registration number; issuer details are not invented", () => {
    expect(taxIncluded(6000)).toBe(545);
    expect(taxIncluded(3300)).toBe(300);
    expect(receiptOf(base, { ...RECEIPT_ISSUER, invoiceRegistrationNo: "T1234567890123" })?.taxJpy).toBe(545);
    expect(RECEIPT_ISSUER.address).toBeNull();
    expect(RECEIPT_ISSUER.invoiceRegistrationNo).toBeNull();
  });
});

describe.each<RepoKind>(["memory", "d1"])("receipt API (%s repo)", (kind) => {
  it("checkout keeps the trimmed 宛名 and the receipt returns the contract shape", async () => {
    const h = await setup(kind);
    const o = await h.buy({ receiptName: "  株式会社サンプル  " });
    expect(o.receiptName).toBe("株式会社サンプル");
    const res = await h.receipt(await h.token(o.id));
    expect(res.status).toBe(200);
    const r = (await res.json()) as LpTicketReceipt;
    expect(r).toEqual({
      orderNumber: o.id.slice(-8).toUpperCase(),
      status: "issued",
      receiptName: "株式会社サンプル",
      items: [{ ticketTypeId: o.items[0]!.ticketTypeId, ticketTypeName: "一般", dayLabel: "Day 1", unitPriceJpy: 3000, quantity: 2 }],
      amountJpy: 6000,
      taxJpy: null,
      paidAt: NOW,
      paymentMethod: null,
      test: false,
      issuer: RECEIPT_ISSUER,
    });
    // The LP管理 order list does not carry the 宛名 (not part of LpTicketOrder).
    const list = (await (await h.app.fetch(get("/lp/tickets/orders"))).json()) as { items: Record<string, unknown>[] };
    expect(list.items[0]).not.toHaveProperty("receiptName");
  });

  it("rejects a bad 宛名 at checkout", async () => {
    const h = await setup(kind);
    const long = await h.checkout({ receiptName: "あ".repeat(lpTickets.LP_TICKET_RECEIPT_NAME_MAX + 1) });
    expect(long.status).toBe(400);
    expect(JSON.stringify(await long.json())).toContain("receiptName");
    expect((await h.checkout({ receiptName: "株式会社\nテスト" })).status).toBe(400);
    expect((await h.checkout({ receiptName: 123 })).status).toBe(400);
    expect((await h.checkout({ receiptName: "" })).status).toBe(200);
    expect((await h.repo.listOrders(SITE, null, 1))[0]!.receiptName).toBeNull();
  });

  it("the 宛名 can be set once afterwards, never changed", async () => {
    const h = await setup(kind);
    const o = await h.buy();
    const t = await h.token(o.id);
    expect(((await (await h.receipt(t)).json()) as LpTicketReceipt).receiptName).toBeNull();
    expect((await h.setName(t, { receiptName: "" })).status).toBe(400);
    expect((await h.setName(t, { receiptName: "a".repeat(61) })).status).toBe(400);
    const ok = await h.setName(t, { receiptName: " 北陸大学 " });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as LpTicketReceipt).receiptName).toBe("北陸大学");
    expect((await h.setName(t, { receiptName: "別の宛名" })).status).toBe(409);
    expect(((await (await h.receipt(t)).json()) as LpTicketReceipt).receiptName).toBe("北陸大学");
  });

  it("404 for a bad token, an unpaid order and a free order; refunded shows as refunded", async () => {
    const h = await setup(kind);
    expect((await h.receipt("tko_x.AAAAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
    expect((await h.receipt("junk")).status).toBe(404);
    expect((await h.checkout({})).status).toBe(200);
    const pending = (await h.repo.listOrders(SITE, null, 1))[0]!;
    expect((await h.receipt(await h.token(pending.id))).status).toBe(404);
    expect((await h.setName(await h.token(pending.id), { receiptName: "x" })).status).toBe(404);
    const free = await h.free();
    expect((await h.receipt(await h.token(free.id))).status).toBe(404);
    // The ticket token of a paid order does not open its receipt.
    const o = await h.buy();
    expect((await h.receipt(await ticketToken(SECRET, `${o.id}-1`))).status).toBe(404);
    expect((await h.receipt(await ticketToken(SECRET, o.id))).status).toBe(404);
    expect(await h.repo.markOrderRefunded(o.id, NOW)).toBe(true);
    const r = (await (await h.receipt(await h.token(o.id))).json()) as LpTicketReceipt;
    expect(r.status).toBe("refunded");
  });

  it("only the LP Worker (s2s) reaches the receipt routes", async () => {
    const h = await setup(kind);
    const o = await h.buy();
    const t = await h.token(o.id);
    expect((await h.app.fetch(get(`/lp/internal/tickets/receipt/${t}`))).status).toBe(403);
    expect((await h.app.fetch(send("POST", `/lp/internal/tickets/receipt/${t}`, { receiptName: "x" }))).status).toBe(403);
  });

  it("the buyer mail links the receipt for a paid order only", async () => {
    const h = await setup(kind);
    const delivery = new TicketDelivery(h.deps);
    const o = await h.buy();
    await delivery.onPaid(o.id);
    await h.flush();
    const paidMail = h.sent.find((m) => m.to === "taro@example.com")!;
    const url = paidMail.text.match(/https:\/\/hokuriku-it-conf\.com\/receipt\/(\S+)/);
    expect(url).not.toBeNull();
    expect(paidMail.html).toContain(`/receipt/${url![1]}`);
    expect((await h.receipt(url![1]!)).status).toBe(200);

    h.sent.length = 0;
    await h.free();
    await h.flush();
    const freeMail = h.sent.find((m) => m.to === "taro@example.com")!;
    expect(freeMail.text).not.toContain("/receipt/");
    expect(freeMail.html).not.toContain("/receipt/");
  });
});

describe("renderBuyerMail", () => {
  it("escapes the receipt URL and omits it when null", () => {
    const order = {
      id: "tko_1",
      buyerName: "山田",
      items: [{ ticketTypeId: "t", ticketTypeName: "一般", dayLabel: "", unitPriceJpy: 3000, quantity: 1 }],
      amountJpy: 3000,
      preview: false,
      stripeSessionId: "cs_live_1",
    } as unknown as TicketOrderRow;
    const withLink = renderBuyerMail(order, [], 'https://x/receipt/a"b');
    expect(withLink.html).toContain("https://x/receipt/a&quot;b");
    expect(withLink.text).toContain("領収書");
    const without = renderBuyerMail(order, []);
    expect(without.text).not.toContain("領収書");
    expect(without.html).not.toContain("領収書");
  });
});
