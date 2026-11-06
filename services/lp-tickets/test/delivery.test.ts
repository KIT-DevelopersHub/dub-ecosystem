// 購入後の受け渡し: 発行・送信・無効化・見直し・バックアップ・CSV。memory / 実 SQL の両方で流す。
import { describe, it, expect, vi } from "vitest";
import { memoryD1 } from "../../../infra/d1/src/node-d1";
import {
  DRAIN_BATCH_MAX,
  MAIL_MIN_INTERVAL_MS,
  OUTBOX_MAX_ATTEMPTS,
  PASS_SUBREQUEST_BUDGET,
  SWEEP_LIMIT,
  TicketDelivery,
  jstDay,
} from "../src/delivery";
import { createResendMailer, type MailResult, type Mailer, type OutboundMail } from "../src/mailer";
import { createStripeClient, signStripePayload } from "../src/stripe";
import { BACKLOG_INTERVAL_MS, RECONCILE_INTERVAL_MS, TicketReconcileDO } from "../src/reconcile-do";
import { csvCell, ordersCsv } from "../src/ticket-csv";
import { orderNumber, renderBuyerMail } from "../src/ticket-mail";
import { ticketToken, verifyTicketToken } from "../src/ticket-token";
import { TicketService } from "../src/tickets";
import type { AppDeps, BackupStore, OutboxRow, TicketOrderRow } from "../src/types";
import type { Env } from "../src/env";
import { DELIVERY_SQL, INIT_SQL, get, makeApp, send, type RepoKind } from "./harness";

const SITE = "hokuriku-it-conf.com";
const SECRET = "ticket-secret-for-tests";
const OPS = "ops@example.com";
const WHSEC = "whsec_test";
const INTERNAL = { "x-dub-internal": "1" };
const NOW = "2026-10-07T03:00:00.000Z";
const TOKEN_IN_TEXT = /\/t\/[^\s"<]+/;

function fakeMailer(script: (mail: OutboundMail, key: string) => MailResult = () => ({ ok: true, id: "re_1" })) {
  const sent: { mail: OutboundMail; key: string }[] = [];
  const calls: string[] = [];
  const mailer: Mailer = {
    async send(mail, key) {
      calls.push(key);
      const r = script(mail, key);
      if (r.ok) sent.push({ mail, key });
      return r;
    },
  };
  return { mailer, sent, calls, buyers: () => sent.filter((s) => s.key.endsWith(":buyer_confirmation")), ops: () => sent.filter((s) => s.key.endsWith(":ops_copy")) };
}

/** Live-mode Stripe: real orders, so the ops copy applies (cs_test_ orders never get one). */
function liveStripe() {
  let n = 0;
  const totals = new Map<string, { amount: number; ref: string | null }>();
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    if ((init?.method ?? "GET") === "POST") {
      const id = `cs_live_${n++}`;
      const form = new URLSearchParams(init?.body as string);
      const amount = Number(form.get("line_items[0][price_data][unit_amount]")) * Number(form.get("line_items[0][quantity]"));
      totals.set(id, { amount, ref: form.get("client_reference_id") });
      return Response.json({ id, url: `https://checkout.stripe.com/${id}`, status: "open", payment_status: "unpaid", livemode: true });
    }
    const id = new URL(url).pathname.split("/").pop()!;
    return Response.json({
      id,
      status: "complete",
      payment_status: "paid",
      amount_total: totals.get(id)?.amount ?? 0,
      currency: "jpy",
      livemode: true,
      payment_intent: `pi_${id}`,
      client_reference_id: totals.get(id)?.ref ?? null,
    });
  };
  return createStripeClient("sk_live_abc", fetchFn);
}

async function setup(kind: RepoKind, deps: Partial<AppDeps> = {}, level: "edit" | "view" = "edit") {
  const mail = fakeMailer();
  const deferred: Promise<unknown>[] = [];
  const h = await makeApp(kind, level, ["lp:publish"], {
    stripe: liveStripe(),
    stripeWebhookSecret: WHSEC,
    mailer: mail.mailer,
    ticketTokenSecret: SECRET,
    ticketOpsEmail: OPS,
    defer: (p) => void deferred.push(p),
    ...deps,
  });
  h.clock.set(NOW);
  const res = await h.app.fetch(send("POST", "/lp/tickets/types", { name: "一般", description: "", priceJpy: 3000, capacity: null, active: true, dayLabel: "Day 1" }));
  const type = (await res.json()) as { id: string };
  await h.app.fetch(send("POST", "/lp/tickets/enabled", { enabled: true }));

  const checkoutBody = (b: Record<string, unknown>) =>
    send("POST", "/lp/internal/tickets/checkout", { name: "山田 太郎", email: "taro@example.com", answers: {}, origin: `https://${SITE}`, ...b }, INTERNAL);
  /** A pending paid order; returns its id. The session id is read back from the repo. */
  const buy = async (quantity = 2) => {
    const r = await h.app.fetch(checkoutBody({ items: [{ ticketTypeId: type.id, quantity }] }));
    expect(r.status).toBe(200);
    return (await h.repo.listOrders(SITE, null, 1))[0]!;
  };
  const webhookEvent = async (event: Record<string, unknown>) => {
    const raw = JSON.stringify({ id: `evt_${Math.random()}`, livemode: true, ...event });
    return h.app.fetch(
      new Request("https://lp/lp/internal/tickets/stripe-webhook", {
        method: "POST",
        headers: { ...INTERNAL, "stripe-signature": await signStripePayload(raw, WHSEC, Math.floor(Date.parse(h.deps.now()) / 1000)) },
        body: raw,
      }),
    );
  };
  const paid = (o: TicketOrderRow, over: Record<string, unknown> = {}) =>
    webhookEvent({
      type: "checkout.session.completed",
      data: {
        object: {
          id: o.stripeSessionId,
          livemode: true,
          currency: "jpy",
          client_reference_id: o.id,
          payment_status: "paid",
          status: "complete",
          amount_total: o.amountJpy,
          payment_intent: `pi_${o.id}`,
          ...over,
        },
      },
    });
  const charge = (o: TicketOrderRow, type: string, object: Record<string, unknown> = {}) =>
    webhookEvent({ type, data: { object: { payment_intent: `pi_${o.id}`, ...object } } });
  const flush = async () => {
    await Promise.all(deferred.splice(0));
  };
  const free = async (quantity = 1, extra: Record<string, unknown> = {}) => {
    const t = (await (await h.app.fetch(send("POST", "/lp/tickets/types", { name: "招待", description: "", priceJpy: 0, capacity: null, active: true }))).json()) as { id: string };
    const c = (await (await h.app.fetch(send("POST", "/lp/tickets/coupons", { ticketTypeId: t.id, maxUses: 100 }))).json()) as { code: string };
    const r = await h.app.fetch(checkoutBody({ items: [{ ticketTypeId: t.id, quantity }], couponCode: c.code, ...extra }));
    expect(r.status).toBe(200);
    return (await h.repo.listOrders(SITE, null, 1))[0]!;
  };
  const delivery = new TicketDelivery(h.deps);
  const service = new TicketService(h.deps);
  const tickets = (id: string) => h.repo.ticketsForOrders([id]);
  const outbox = async (id: string): Promise<Record<string, OutboxRow>> =>
    Object.fromEntries((await h.repo.listOrderOutbox(id)).map((r) => [r.kind, r]));
  /** The daily job uses up a pass's subrequests, so mail tests start with today's run behind them. */
  const dailyDone = () => h.repo.setJobState("backup_day", jstDay(h.deps.now()), h.deps.now());
  return { ...h, mail, type, buy, paid, charge, free, flush, delivery, service, tickets, outbox, deferred, checkoutBody, dailyDone };
}

const later = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();

describe.each<RepoKind>(["memory", "d1"])("delivery (%s repo)", (kind) => {
  // ---- every paid route converges on fulfil, exactly once ----

  it("webhook: one ticket per seat, buyer + ops mail once, replay changes nothing", async () => {
    const h = await setup(kind);
    const o = await h.buy(3);
    expect(await h.tickets(o.id)).toEqual([]);
    expect((await h.paid(o)).status).toBe(200);
    await h.flush();
    expect((await h.tickets(o.id)).map((t) => t.id)).toEqual([`${o.id}-1`, `${o.id}-2`, `${o.id}-3`]);
    expect(h.mail.buyers()).toHaveLength(1);
    expect(h.mail.ops()).toHaveLength(1);
    await h.dailyDone();
    await h.paid(o);
    await h.flush();
    await h.service.reconcile();
    expect(await h.tickets(o.id)).toHaveLength(3);
    expect(h.mail.calls).toHaveLength(2);
  });

  it("confirm settles and fulfils", async () => {
    const h = await setup(kind);
    const o = await h.buy();
    const res = await h.app.fetch(send("POST", "/lp/internal/tickets/confirm", { sessionId: o.stripeSessionId }, INTERNAL));
    expect(await res.json()).toMatchObject({ status: "paid", orderNumber: orderNumber(o.id) });
    await h.flush();
    expect(h.mail.buyers()).toHaveLength(1);
  });

  it("reconcile settles and fulfils, sending in the same pass", async () => {
    const h = await setup(kind, { defer: null });
    await h.dailyDone();
    const o = await h.buy();
    h.clock.set(later(6 * 60 * 1000));
    const sum = await h.service.reconcile();
    expect(sum).toMatchObject({ paid: 1, mailSent: 2, mailBacklog: 0 });
    expect(await h.tickets(o.id)).toHaveLength(2);
  });

  it("free coupon order fulfils at checkout and arms the alarm", async () => {
    let arms = 0;
    const h = await setup(kind, { armReconcile: async () => void arms++ });
    const o = await h.free(2);
    await h.flush();
    expect(o.status).toBe("paid");
    expect(await h.tickets(o.id)).toHaveLength(2);
    expect(h.mail.buyers()).toHaveLength(1);
    expect(arms).toBe(1);
  });

  it("needs_review is not fulfilled; approve fulfils and mails once", async () => {
    const h = await setup(kind);
    await h.dailyDone();
    const o = await h.buy();
    await h.paid(o, { amount_total: 1 });
    await h.flush();
    expect((await h.repo.getOrder(SITE, o.id))!.status).toBe("needs_review");
    await h.service.reconcile();
    expect(await h.tickets(o.id)).toEqual([]);
    expect(h.mail.calls).toEqual([]);
    expect((await h.app.fetch(send("POST", `/lp/tickets/orders/${o.id}/approve`, {}))).status).toBe(200);
    await h.flush();
    expect(await h.tickets(o.id)).toHaveLength(2);
    expect(h.mail.buyers()).toHaveLength(1);
  });

  it("dispute: mail waits while it is open; won keeps one set of tickets and sends it", async () => {
    const send5xx = { value: true };
    const mail = fakeMailer(() => (send5xx.value ? { ok: false, failure: "transient", error: "resend_500_unknown" } : { ok: true, id: "re_1" }));
    const h = await setup(kind, { mailer: mail.mailer });
    const o = await h.buy();
    await h.paid(o); // paid, mail stuck pending
    await h.flush();
    await h.charge(o, "charge.dispute.created");
    await h.flush();
    send5xx.value = false;
    h.clock.set(later(10 * 60 * 1000));
    await h.delivery.drain();
    expect(mail.sent).toEqual([]);
    expect((await h.outbox(o.id)).buyer_confirmation).toMatchObject({ status: "pending", attempts: 0, lastError: "order_on_hold" });
    await h.charge(o, "charge.dispute.closed", { status: "won" });
    await h.flush();
    h.clock.set(later(2 * 60 * 60 * 1000));
    await h.delivery.drain();
    expect(await h.tickets(o.id)).toHaveLength(2);
    expect(mail.sent.filter((s) => s.key.endsWith("buyer_confirmation"))).toHaveLength(1);
  });

  it("an order that was never fulfilled gets its tickets when the dispute is won", async () => {
    const h = await setup(kind);
    const o = await h.buy();
    await h.repo.markOrderPaid(o.id, { paidAt: NOW, sessionId: null, paymentIntentId: `pi_${o.id}` });
    await h.charge(o, "charge.dispute.created");
    await h.charge(o, "charge.dispute.closed", { status: "won" });
    await h.flush();
    expect(await h.tickets(o.id)).toHaveLength(2);
    expect(h.mail.buyers()).toHaveLength(1);
  });

  // ---- refund / void ----

  it("full refund and lost dispute void every ticket; a partial refund does not", async () => {
    const h = await setup(kind);
    const a = await h.buy();
    await h.paid(a);
    await h.charge(a, "charge.refunded", { amount: 6000, amount_refunded: 1000 });
    expect((await h.tickets(a.id)).every((t) => t.status === "valid")).toBe(true);
    await h.charge(a, "charge.refunded", { amount: 6000, amount_refunded: 6000 });
    expect((await h.tickets(a.id)).every((t) => t.status === "void" && t.voidedAt === NOW)).toBe(true);

    const b = await h.buy();
    await h.paid(b);
    await h.charge(b, "charge.dispute.created");
    await h.charge(b, "charge.dispute.closed", { status: "lost" });
    expect((await h.tickets(b.id)).every((t) => t.status === "void")).toBe(true);
  });

  it("a refund before the mail went out stops it for good", async () => {
    const mail = fakeMailer(() => ({ ok: false, failure: "transient", error: "resend_500_unknown" }));
    const h = await setup(kind, { mailer: mail.mailer });
    const o = await h.buy();
    await h.paid(o);
    await h.flush();
    await h.charge(o, "charge.refunded", { amount: 6000, amount_refunded: 6000 });
    await h.flush();
    h.clock.set(later(10 * 60 * 1000));
    const calls = mail.calls.length;
    await h.delivery.drain();
    expect(mail.calls.length).toBe(calls);
    expect((await h.outbox(o.id)).buyer_confirmation).toMatchObject({ status: "failed", lastError: "order_refunded" });
  });

  it("fulfil after a refund issues nothing (a late retry cannot revive the order)", async () => {
    const h = await setup(kind);
    const o = await h.buy();
    await h.repo.markOrderPaid(o.id, { paidAt: NOW, sessionId: null, paymentIntentId: `pi_${o.id}` });
    await h.repo.markOrderRefunded(o.id, NOW);
    await h.delivery.fulfill(o.id);
    expect(await h.tickets(o.id)).toEqual([]);
    expect(await h.repo.listOrderOutbox(o.id)).toEqual([]);
  });

  // ---- test orders ----

  it("Stripe test-mode and preview orders get the buyer mail but no ops copy", async () => {
    const h = await setup(kind, { ticketPreviewKey: "sk_test_preview" });
    await h.repo.setTicketEnabled(SITE, false, "usr", NOW);
    const { token } = (await (await h.app.fetch(send("POST", "/lp/tickets/preview-token", {}))).json()) as { token: string };
    const o = await h.free(1, { previewToken: token });
    await h.flush();
    expect((await h.repo.getOrder(SITE, o.id))!.preview).toBe(true);
    expect(h.mail.buyers()).toHaveLength(1);
    expect(h.mail.buyers()[0]!.mail.subject).toContain("チケット");
    expect(h.mail.ops()).toEqual([]);
    expect((await h.outbox(o.id)).ops_copy).toBeUndefined();

    await h.repo.setTicketEnabled(SITE, true, "usr", NOW);
    const paid = await h.buy();
    await h.repo.setOrderSession(paid.id, "cs_test_x");
    await h.repo.markOrderPaid(paid.id, { paidAt: NOW, sessionId: null, paymentIntentId: null });
    await h.delivery.fulfill(paid.id);
    expect((await h.outbox(paid.id)).ops_copy).toBeUndefined();
    await h.service.reconcile();
    expect((await h.outbox(paid.id)).ops_copy).toBeUndefined();
  });

  // ---- idempotency under concurrency ----

  it("concurrent fulfils and drains send each mail once", async () => {
    const h = await setup(kind, { defer: null });
    const orders = [await h.buy(), await h.buy()];
    for (const o of orders) {
      await h.paid(o);
      await Promise.all([h.delivery.fulfill(o.id), h.delivery.fulfill(o.id), h.delivery.fulfill(o.id)]);
    }
    await Promise.all([h.delivery.drain(), h.delivery.drain(), h.delivery.drain()]);
    expect(h.mail.calls.slice().sort()).toEqual(orders.flatMap((o) => [`${o.id}:buyer_confirmation`, `${o.id}:ops_copy`]).sort());
    expect(await h.tickets(orders[0]!.id)).toHaveLength(2);
  });

  it("a crashed drain's lease expires and the retry uses the same Idempotency-Key", async () => {
    const h = await setup(kind, { defer: null });
    const o = await h.buy();
    await h.paid(o);
    const claimed = await h.repo.claimOutbox({ now: NOW, leaseUntil: later(120_000), kinds: ["buyer_confirmation"], limit: 5 });
    expect(claimed.map((r) => r.id)).toEqual([`${o.id}:buyer_confirmation`]);
    await h.delivery.drain();
    expect(h.mail.buyers()).toEqual([]);
    h.clock.set(later(121_000));
    await h.delivery.drain();
    expect(h.mail.buyers().map((s) => s.key)).toEqual([`${o.id}:buyer_confirmation`]);
  });

  // ---- failure handling ----

  it("mail failure never breaks settlement, and the mail is retried", async () => {
    let down = true;
    const mail = fakeMailer(() => (down ? { ok: false, failure: "transient", error: "timeout" } : { ok: true, id: "re_1" }));
    const h = await setup(kind, { mailer: mail.mailer });
    const o = await h.buy();
    expect((await h.paid(o)).status).toBe(200);
    await h.flush();
    expect((await h.repo.getOrder(SITE, o.id))!.status).toBe("paid");
    expect((await h.outbox(o.id)).buyer_confirmation).toMatchObject({ status: "pending", attempts: 0, lastError: "timeout" });
    down = false;
    h.clock.set(later(6 * 60 * 1000));
    await h.delivery.drain();
    expect((await h.outbox(o.id)).buyer_confirmation).toMatchObject({ status: "sent", lastError: null, sentAt: later(6 * 60 * 1000) });
  });

  it("a mailer or repo blowing up does not fail the payment path", async () => {
    const h = await setup(kind, { mailer: { send: async () => Promise.reject(new Error("boom")) } });
    const o = await h.buy();
    const repo = h.repo as { issueFulfilment: unknown };
    const original = repo.issueFulfilment;
    repo.issueFulfilment = async () => Promise.reject(new Error("d1 down"));
    expect((await h.paid(o)).status).toBe(200);
    await h.flush();
    expect((await h.repo.getOrder(SITE, o.id))!.status).toBe("paid");
    repo.issueFulfilment = original;
    await h.service.reconcile(); // the sweep heals it
    expect(await h.tickets(o.id)).toHaveLength(2);
  });

  it("a refused address backs off, ends in failed, and never stores mail content", async () => {
    const mail = fakeMailer((m) => (m.to === OPS ? { ok: true, id: "re" } : { ok: false, failure: "rejected", error: "resend_422_validation_error" }));
    const h = await setup(kind, { mailer: mail.mailer, defer: null });
    const o = await h.buy();
    await h.paid(o);
    let t = Date.parse(NOW);
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) {
      await h.delivery.drain();
      t += 2 * 60 * 60 * 1000;
      h.clock.set(new Date(t).toISOString());
    }
    const row = (await h.outbox(o.id)).buyer_confirmation!;
    expect(row).toMatchObject({ status: "failed", attempts: OUTBOX_MAX_ATTEMPTS, lastError: "resend_422_validation_error" });
    expect(JSON.stringify(row)).not.toMatch(/\/t\/|taro@example/);
    const calls = mail.calls.length;
    h.clock.set(new Date(t + 1e8).toISOString());
    await h.delivery.drain();
    expect(mail.calls.length).toBe(calls);
  });

  it("backs off exponentially up to the cap", async () => {
    const mail = fakeMailer(() => ({ ok: false, failure: "rejected", error: "resend_422_x" }));
    const h = await setup(kind, { mailer: mail.mailer, defer: null });
    const o = await h.buy();
    await h.paid(o);
    await h.delivery.drain();
    expect((await h.outbox(o.id)).buyer_confirmation).toMatchObject({ attempts: 1, nextAttemptAt: later(60_000) });
    h.clock.set(later(60_000));
    await h.delivery.drain();
    expect((await h.outbox(o.id)).buyer_confirmation).toMatchObject({ attempts: 2, nextAttemptAt: later(60_000 + 120_000) });
  });

  it("429 stops the batch, keeps attempts, honours Retry-After and reports backlog", async () => {
    let n = 0;
    const mail = fakeMailer(() => (n++ === 0 ? { ok: true, id: "re" } : { ok: false, failure: "rate_limited", error: "resend_429_x", retryAfterSec: 90 }));
    const h = await setup(kind, { mailer: mail.mailer, defer: null });
    const orders = [await h.buy(), await h.buy(), await h.buy()];
    for (const o of orders) await h.paid(o);
    const sum = await h.delivery.drainPass();
    expect(mail.calls).toHaveLength(2);
    expect(sum).toMatchObject({ mailSent: 1, mailRetried: 5, mailBacklog: 5 });
    const limited = (await h.outbox(orders[1]!.id)).buyer_confirmation!;
    expect(limited).toMatchObject({ status: "pending", attempts: 0, lastError: "resend_429_x", nextAttemptAt: later(90_000) });
    // the rows behind it were not tried: they go straight back
    expect((await h.outbox(orders[2]!.id)).buyer_confirmation).toMatchObject({ attempts: 0, lastError: null, nextAttemptAt: NOW });
  });

  it("daily cap: buyer mails go first, the rest wait without losing attempts, and the next JST day resumes", async () => {
    const mail = fakeMailer(() => ({ ok: true, id: "re" }));
    const h = await setup(kind, { mailer: mail.mailer, defer: null, ticketMailDailyCap: 2 });
    const orders = [await h.buy(), await h.buy(), await h.buy()];
    for (const o of orders) await h.paid(o);
    const sum = await h.delivery.drainPass();
    expect(mail.calls).toHaveLength(2);
    expect(sum).toMatchObject({ mailSent: 2, mailBacklog: 4 });
    expect(mail.ops()).toHaveLength(0);
    await h.delivery.drainPass();
    expect(mail.calls).toHaveLength(2);
    expect((await h.outbox(orders[2]!.id)).buyer_confirmation).toMatchObject({ status: "pending", attempts: 0 });
    h.clock.set(later(24 * 60 * 60 * 1000));
    await h.delivery.drainPass();
    expect(mail.calls).toHaveLength(4);
    expect((await h.outbox(orders[2]!.id)).buyer_confirmation).toMatchObject({ status: "sent" });
  });

  it("the immediate send asks for the alarm soon when Resend pushes back", async () => {
    const soon: boolean[] = [];
    const mail = fakeMailer(() => ({ ok: false, failure: "rate_limited", error: "resend_429_x" }));
    const h = await setup(kind, { mailer: mail.mailer, armReconcile: async (o) => void soon.push(o?.soon === true) });
    const o = await h.buy();
    await h.paid(o);
    await h.flush();
    expect(soon).toContain(true);
  });

  it("paces sends, and stops at the wall-clock budget with the rest back in the queue", async () => {
    const sleeps: number[] = [];
    const clockRef: { set?: (iso: string) => void; t: number } = { t: Date.parse(NOW) };
    const h = await setup(kind, {
      defer: null,
      sleep: async (ms) => {
        sleeps.push(ms);
        clockRef.t += 10_000;
        clockRef.set!(new Date(clockRef.t).toISOString());
      },
    });
    clockRef.set = h.clock.set;
    for (let i = 0; i < 3; i++) await h.paid(await h.buy());
    const r = await h.delivery.drain({ budgetMs: 15_000 });
    expect(r).toEqual({ sent: 2, retried: 4, failed: 0 });
    expect(sleeps).toEqual([MAIL_MIN_INTERVAL_MS, MAIL_MIN_INTERVAL_MS]);
    const left = await h.repo.claimOutbox({ now: new Date(clockRef.t).toISOString(), leaseUntil: later(1e6), kinds: ["buyer_confirmation", "ops_copy"], limit: 10 });
    expect(left).toHaveLength(4);
  });

  it("never claims more than one batch, and a pass leaves subrequests for what Stripe used", async () => {
    const h = await setup(kind, { defer: null });
    for (let i = 0; i < 20; i++) await h.paid(await h.buy(1));
    const first = await h.delivery.drain({ limit: 1000 });
    expect(first.sent).toBe(DRAIN_BATCH_MAX);
    const pass = await h.delivery.reconcilePass(PASS_SUBREQUEST_BUDGET);
    expect(pass.mailSent).toBe(0);
    expect(pass.mailBacklog).toBe(10);
  });

  // ---- missing configuration ----

  it("no TICKET_TOKEN_SECRET: orders work, buyer mail stays pending, nothing broken is sent", async () => {
    const h = await setup(kind, { ticketTokenSecret: null, defer: null });
    const o = await h.buy();
    expect((await h.paid(o)).status).toBe(200);
    expect(await h.tickets(o.id)).toHaveLength(2);
    await h.dailyDone();
    const sum = await h.service.reconcile();
    expect(h.mail.buyers()).toEqual([]);
    expect(h.mail.ops()).toHaveLength(1);
    expect((await h.outbox(o.id)).buyer_confirmation).toMatchObject({ status: "pending", attempts: 0 });
    expect(sum.mailBacklog).toBe(0);
    const healed = new TicketDelivery({ ...h.deps, ticketTokenSecret: SECRET });
    await healed.drain();
    expect(h.mail.buyers()).toHaveLength(1);
  });

  it("no TICKET_OPS_EMAIL: the ops copy stays pending and is not marked sent", async () => {
    const h = await setup(kind, { ticketOpsEmail: null, defer: null });
    const o = await h.buy();
    await h.paid(o);
    await h.dailyDone();
    await h.service.reconcile();
    expect(h.mail.buyers()).toHaveLength(1);
    expect((await h.outbox(o.id)).ops_copy).toMatchObject({ status: "pending", sentAt: null });
  });

  it("no RESEND_API_KEY: nothing sent, everything stays pending", async () => {
    const h = await setup(kind, { mailer: null });
    const o = await h.buy();
    expect((await h.paid(o)).status).toBe(200);
    await h.flush();
    expect((await h.service.reconcile()).mailBacklog).toBe(0);
    expect((await h.outbox(o.id)).buyer_confirmation!.status).toBe("pending");
  });

  // ---- mail content ----

  it("the buyer mail lists every ticket with URL and QR; the ops mail has the data but no credential", async () => {
    const h = await setup(kind);
    const o = await h.buy(2);
    await h.paid(o);
    await h.flush();
    const buyer = h.mail.buyers()[0]!.mail;
    expect(buyer).toMatchObject({ to: "taro@example.com", from: h.deps.ticketMailFrom });
    for (const t of await h.tickets(o.id)) {
      const url = `https://${SITE}/t/${await ticketToken(SECRET, t.id)}`;
      expect(buyer.text).toContain(url);
      expect(buyer.html).toContain(`<img src="${url}/qr.png"`);
    }
    expect(buyer.text).toContain(orderNumber(o.id));
    expect(buyer.text).toContain("転送");

    const ops = h.mail.ops()[0]!.mail;
    expect(ops.to).toBe(OPS);
    expect(ops.text).toContain(o.id);
    expect(ops.text).toContain("山田 太郎");
    expect(ops.text).toContain("taro@example.com");
    expect(ops.text).not.toMatch(TOKEN_IN_TEXT);
    expect(`${ops.subject}${ops.text}${ops.html ?? ""}`).not.toContain(await ticketToken(SECRET, `${o.id}-1`));
  });

  it("escapes buyer-controlled text in the html", async () => {
    const h = await setup(kind);
    const o = await h.buy(1);
    const html = renderBuyerMail({ ...o, buyerName: '<img src=x onerror="a">' }, []).html!;
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  // ---- sweep ----

  it("sweep heals a crash between paid and fulfil; it fills only what is missing", async () => {
    const h = await setup(kind, { defer: null });
    await h.dailyDone();
    const o = await h.buy();
    await h.repo.markOrderPaid(o.id, { paidAt: NOW, sessionId: null, paymentIntentId: null });
    const sum = await h.service.reconcile();
    expect(sum).toMatchObject({ fulfilled: 1, mailSent: 2 });
    expect((await h.service.reconcile()).fulfilled).toBe(0);
  });

  it("after the day's full look, only recent orders are read; the next day finds old ones", async () => {
    const h = await setup(kind, { defer: null, ticketOpsEmail: null, mailer: null });
    await h.service.reconcile(); // today's full look is done
    const o = await h.buy();
    await h.repo.markOrderPaid(o.id, { paidAt: later(-2 * 60 * 60 * 1000), sessionId: null, paymentIntentId: null });
    expect((await h.service.reconcile()).fulfilled).toBe(0);
    h.clock.set(later(24 * 60 * 60 * 1000));
    expect((await h.service.reconcile()).fulfilled).toBe(1);
  });

  it("a full look that hit its limit carries on in the next pass", async () => {
    const h = await setup(kind, { defer: null, mailer: null });
    const ids: string[] = [];
    for (let i = 0; i < SWEEP_LIMIT + 1; i++) {
      const o = await h.buy(1);
      await h.repo.markOrderPaid(o.id, { paidAt: later(-5 * 60 * 60 * 1000), sessionId: null, paymentIntentId: null });
      ids.push(o.id);
    }
    expect((await h.service.reconcile()).fulfilled).toBe(SWEEP_LIMIT);
    expect((await h.service.reconcile()).fulfilled).toBe(1);
  });

  // ---- pass endpoint ----

  it("pass: shows public fields only; void shows as void; any bad token is the same 404", async () => {
    const h = await setup(kind);
    const o = await h.buy(1);
    await h.paid(o);
    const token = await ticketToken(SECRET, `${o.id}-1`);
    const pass = (t: string) => h.app.fetch(get(`/lp/internal/tickets/pass/${encodeURIComponent(t)}`, INTERNAL));
    const res = await pass(token);
    expect(await res.json()).toEqual({
      event: "北陸ITカンファレンス 2027",
      ticketTypeName: "一般",
      dayLabel: "Day 1",
      status: "valid",
      orderRef: orderNumber(o.id),
    });
    const bad = [`${token.slice(0, -1)}A`, `${o.id}-2.${token.split(".")[1]}`, "x", `${o.id}-99.AAAAAAAAAAAAAAAAAAAAAAAA`, await ticketToken("other-secret", `${o.id}-1`)];
    const bodies = new Set<string>();
    for (const t of bad) {
      const r = await pass(t);
      expect(r.status).toBe(404);
      bodies.add(JSON.stringify({ ...((await r.json()) as object), requestId: undefined }));
    }
    expect(bodies.size).toBe(1);
    await h.charge(o, "charge.refunded", { amount: 3000, amount_refunded: 3000 });
    expect(await (await pass(token)).json()).toMatchObject({ status: "void" });
    expect((await h.app.fetch(get(`/lp/internal/tickets/pass/${token}`))).status).toBe(403);
  });

  // ---- backup + export ----

  function fakeBackup(fail = false) {
    const objects = new Map<string, string>();
    const store: BackupStore = {
      exists: async (k) => objects.has(k),
      put: async (k, v) => {
        if (fail) throw new Error("r2 down");
        objects.set(k, v);
      },
    };
    return { objects, store };
  }

  it("backup: once per JST day, complete, and free of tokens", async () => {
    const b = fakeBackup();
    const h = await setup(kind, { backup: b.store, defer: null });
    const o = await h.buy(2);
    await h.paid(o);
    await h.service.reconcile();
    const key = `tickets/${jstDay(NOW)}.json`;
    expect([...b.objects.keys()]).toEqual([key]);
    const snap = JSON.parse(b.objects.get(key)!) as Record<string, unknown[]>;
    expect(snap.orders).toHaveLength(1);
    expect(snap.tickets).toHaveLength(2);
    expect(snap.types!.length).toBe(1);
    expect(snap.settings).toBeTruthy();
    expect(snap.coupons).toEqual([]);
    const raw = b.objects.get(key)!;
    for (const t of await h.tickets(o.id)) {
      expect(raw).not.toContain((await ticketToken(SECRET, t.id)).split(".")[1]);
    }
    expect(raw).not.toMatch(TOKEN_IN_TEXT);

    b.objects.set(key, "untouched");
    await h.service.reconcile();
    expect(b.objects.get(key)).toBe("untouched");
    h.clock.set("2026-10-07T15:00:00.000Z"); // 00:00 JST on the 8th
    await h.service.reconcile();
    expect(b.objects.has("tickets/2026-10-08.json")).toBe(true);
  });

  it("an object already in R2 is not overwritten", async () => {
    const b = fakeBackup();
    b.objects.set(`tickets/${jstDay(NOW)}.json`, "kept");
    const h = await setup(kind, { backup: b.store, defer: null });
    await h.service.reconcile();
    expect(b.objects.get(`tickets/${jstDay(NOW)}.json`)).toBe("kept");
  });

  it("the daily CSV goes to ops only when orders changed, without tokens", async () => {
    const h = await setup(kind, { defer: null, backup: fakeBackup().store });
    const daily = () => h.mail.sent.filter((s) => s.key.startsWith("daily-"));
    await h.service.reconcile();
    expect(daily()).toEqual([]); // no orders yet
    h.clock.set("2026-10-08T03:00:00.000Z");
    const o = await h.buy();
    await h.paid(o);
    await h.service.reconcile();
    expect(daily()).toHaveLength(1);
    const m = daily()[0]!.mail;
    expect(m.to).toBe(OPS);
    const csv = new TextDecoder().decode(Uint8Array.from(atob(m.attachments![0]!.contentBase64), (c) => c.charCodeAt(0)));
    expect(csv).toContain(o.id);
    expect(csv).not.toMatch(TOKEN_IN_TEXT);
    h.clock.set("2026-10-09T03:00:00.000Z");
    await h.service.reconcile();
    expect(daily()).toHaveLength(1); // nothing changed
  });

  it("a backup failure is logged, does not stop the pass, and is retried", async () => {
    const bad = fakeBackup(true);
    const h = await setup(kind, { backup: bad.store, defer: null });
    const o = await h.buy();
    await h.paid(o);
    const sum = await h.service.reconcile();
    expect(sum.mailSent).toBe(2);
    expect((await h.repo.getJobStates()).has("backup_day")).toBe(false);
    expect((await h.outbox(o.id)).buyer_confirmation!.status).toBe("sent");
  });

  it("export: all orders past one internal page, BOM, one row per order, answers by label", async () => {
    const h = await setup(kind);
    await h.app.fetch(send("POST", "/lp/tickets/fields", { fields: [{ id: "org", label: "所属", type: "text", required: false, options: [] }] }));
    const o = await h.buy();
    await h.repo.setTicketFields(SITE, [], "usr", NOW);
    const res = await h.app.fetch(get("/lp/tickets/orders/export"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("lp-ticket-orders-2026-10-07.csv");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text.trim().split("\r\n")).toHaveLength(2);
    expect(text).toContain(o.id);
  });

  it("export pages through every order", async () => {
    const h = await setup(kind);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await h.buy(1)).id);
    let cursor: string | null = null;
    const seen: string[] = [];
    for (;;) {
      const page: TicketOrderRow[] = await h.repo.listOrdersAscending(SITE, cursor, 2);
      if (page.length === 0) break;
      for (const o of page) {
        expect(o.items).toHaveLength(1);
        seen.push(o.id);
      }
      const last = page[page.length - 1]!;
      cursor = `${last.createdAt}~${last.id}`;
    }
    expect(seen).toEqual(ids);
    expect((await h.delivery.allOrders()).map((o) => o.id)).toEqual(ids);
  });

  it("export needs lp:publish", async () => {
    const h = await makeApp(kind, "edit");
    expect((await h.app.fetch(get("/lp/tickets/orders/export"))).status).toBe(403);
  });
});

describe("ticket token", () => {
  it("round-trips, carries 128+ bits, and is URL safe", async () => {
    const t = await ticketToken(SECRET, "tko_01ABC-1");
    expect(t).toMatch(/^tko_01ABC-1\.[A-Za-z0-9_-]{24}$/);
    expect(await verifyTicketToken(SECRET, t)).toBe("tko_01ABC-1");
  });

  it("rejects forgery and tampering", async () => {
    const t = await ticketToken(SECRET, "tko_01ABC-1");
    const [id, sig] = t.split(".") as [string, string];
    for (const bad of [
      `tko_01ABC-2.${sig}`,
      `${id}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`,
      `${id}.${sig.slice(0, 22)}`,
      `${id}.${sig}AA`,
      id,
      `${t}.x`,
      "",
      await ticketToken("other", id),
    ]) {
      expect(await verifyTicketToken(SECRET, bad)).toBeNull();
    }
    expect(await verifyTicketToken(null, t)).toBeNull();
    expect(await verifyTicketToken(SECRET, 123)).toBeNull();
  });
});

describe("CSV", () => {
  it("neutralises formula injection", () => {
    for (const v of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx", "＝1", " =1"]) {
      expect(csvCell(v).replace(/^"/, "").startsWith("'")).toBe(true);
    }
    expect(csvCell("山田")).toBe("山田");
    expect(csvCell(100)).toBe("100");
    expect(csvCell(null)).toBe("");
  });

  it("quotes separators, quotes and newlines", () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell("=a,b")).toBe(`"'=a,b"`);
  });

  it("builds one row per order with answer columns from settings and old orders", () => {
    const order = {
      id: "tko_1",
      items: [{ ticketTypeId: "t", ticketTypeName: "一般", dayLabel: "", unitPriceJpy: 1, quantity: 1 }],
      answers: [{ fieldId: "a", label: "所属", value: "=cmd" }, { fieldId: "b", label: "旧項目", value: "x" }],
      buyerName: "@evil",
      buyerEmail: "a@example.com",
      status: "paid",
      preview: false,
      stripeSessionId: null,
      quantity: 1,
      amountJpy: 1,
      paymentMethod: null,
      couponId: null,
      createdAt: "c",
      paidAt: null,
      refundedAt: null,
    } as unknown as TicketOrderRow;
    const csv = ordersCsv([order], [{ id: "a", label: "所属", type: "text", required: false, options: [] }]);
    const [head, row] = csv.replace("﻿", "").trim().split("\r\n");
    expect(head!.endsWith(",所属,旧項目")).toBe(true);
    expect(row).toContain("'@evil");
    expect(row).toContain(",'=cmd,x");
  });
});

describe("Resend mailer", () => {
  const MAIL: OutboundMail = { from: "f", to: "t@example.com", subject: "s\nx", text: "b" };

  it("posts with the bearer key and Idempotency-Key", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const m = createResendMailer("re_key", (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ id: "abc" });
    }) as unknown as typeof fetch);
    expect(await m.send(MAIL, "tko_1:ops_copy")).toEqual({ ok: true, id: "abc" });
    const h = new Headers(calls[0]!.init.headers);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect(h.get("authorization")).toBe("Bearer re_key");
    expect(h.get("idempotency-key")).toBe("tko_1:ops_copy");
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ to: ["t@example.com"], subject: "s x" });
  });

  it.each([
    [429, "rate_limited"],
    [500, "transient"],
    [503, "transient"],
    [401, "transient"],
    [403, "transient"],
    [422, "rejected"],
    [400, "rejected"],
  ])("classifies %i as %s", async (status, failure) => {
    const m = createResendMailer("k", (async () => new Response(JSON.stringify({ name: "some_error", message: "taro@example.com is bad" }), { status, headers: { "retry-after": "7" } })) as unknown as typeof fetch);
    const r = await m.send(MAIL, "k");
    expect(r).toMatchObject({ ok: false, failure });
    expect(JSON.stringify(r)).not.toContain("taro@");
    if (status === 429) expect(r).toMatchObject({ retryAfterSec: 7 });
  });

  it("maps a network error, a timeout and a body without id to a retry", async () => {
    const net = createResendMailer("k", (async () => Promise.reject(new TypeError("x"))) as unknown as typeof fetch);
    expect(await net.send(MAIL, "k")).toMatchObject({ failure: "transient", error: "network_error" });
    const slow = createResendMailer("k", ((_u: string, init: RequestInit) => new Promise((_, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason)))) as unknown as typeof fetch, 1);
    expect(await slow.send(MAIL, "k")).toMatchObject({ failure: "transient", error: "timeout" });
    const noId = createResendMailer("k", (async () => Response.json({})) as unknown as typeof fetch);
    expect(await noId.send(MAIL, "k")).toMatchObject({ failure: "transient", error: "resend_no_id" });
  });
});

describe("reconcile DO", () => {
  function doState() {
    let alarm: number | null = null;
    const kv = new Map<string, unknown>();
    const state = {
      storage: {
        getAlarm: async () => alarm,
        setAlarm: async (at: number) => void (alarm = at),
        get: async (k: string) => kv.get(k),
        put: async (k: string, v: unknown) => void kv.set(k, v),
      },
    };
    return { state, alarm: () => alarm, kv };
  }
  const make = async (s: ReturnType<typeof doState>, sql: string[] = []) => {
    const { db } = memoryD1();
    await db.exec(INIT_SQL);
    await db.exec(DELIVERY_SQL);
    for (const q of sql) await db.exec(q);
    const env = { DB: db, SVC_IDENTITY: {}, RESEND_API_KEY: "re_k", TICKET_TOKEN_SECRET: SECRET } as unknown as Env;
    return new TicketReconcileDO(s.state as never, env);
  };
  const ARM = (soon = false) => new Request(`https://x/arm${soon ? "?soon=1" : ""}`, { method: "POST" });

  it("arming never pushes the alarm back; soon brings it forward", async () => {
    vi.useFakeTimers({ now: Date.parse(NOW) });
    try {
      const s = doState();
      const d = await make(s);
      await d.fetch(ARM());
      const t0 = Date.parse(NOW);
      expect(s.alarm()).toBe(t0 + RECONCILE_INTERVAL_MS);
      vi.advanceTimersByTime(5000);
      await d.fetch(ARM());
      expect(s.alarm()).toBe(t0 + RECONCILE_INTERVAL_MS);
      await d.fetch(ARM(true));
      expect(s.alarm()).toBe(t0 + 5000 + BACKLOG_INTERVAL_MS);
      vi.advanceTimersByTime(1000);
      await d.fetch(ARM(true));
      expect(s.alarm()).toBe(t0 + 5000 + BACKLOG_INTERVAL_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a backlog brings the alarm back in a minute and only the 10-minute tick is a full pass", async () => {
    const insert = `INSERT INTO lp_ticket_outbox (id, order_id, kind, next_attempt_at, created_at)
      VALUES ('o:buyer_confirmation', 'o', 'buyer_confirmation', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`;
    const s = doState();
    const d = await make(s, [insert]);
    const before = Date.now();
    await d.alarm();
    expect(s.alarm()!).toBeLessThanOrEqual(Date.now() + BACKLOG_INTERVAL_MS);
    expect(s.alarm()!).toBeGreaterThanOrEqual(before + BACKLOG_INTERVAL_MS);
    const full = s.kv.get("lastFullAt");
    expect(full).toBeGreaterThanOrEqual(before);
    await d.alarm();
    expect(s.kv.get("lastFullAt")).toBe(full);
  });

  it("no backlog: the normal interval", async () => {
    const s = doState();
    const d = await make(s);
    const before = Date.now();
    await d.alarm();
    expect(s.alarm()!).toBeGreaterThanOrEqual(before + RECONCILE_INTERVAL_MS);
  });
});
