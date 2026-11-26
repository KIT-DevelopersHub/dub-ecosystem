// LP管理: 返金（有料 = Stripe Refund API）/ 取消（0 円）。Stripe は fetch を差し替えた偽物で、実際には呼ばない。
import { describe, it, expect } from "vitest";
import { lpTickets } from "@dub/types";
import type { Mailer, OutboundMail } from "../src/mailer";
import { createStripeClient, signStripePayload } from "../src/stripe";
import { createDbClient } from "@dub/db";
import { memoryD1 } from "../../../infra/d1/src/node-d1";
import { createD1TicketRepo } from "../src/d1-repo";
import { OUTBOX_MAX_ATTEMPTS, OUTBOX_TRANSIENT_RETRY_MS, TicketDelivery } from "../src/delivery";
import type { MailResult } from "../src/mailer";
import type { LpTicketCoupon, LpTicketRefundResponse, LpTicketRepo, LpTicketTypeSummary, OutboxRow } from "../src/types";
import { CHECKIN_SQL, DELIVERY_SQL, INIT_SQL, get, makeApp, send, type RepoKind } from "./harness";

const body = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const INTERNAL = { "x-dub-internal": "1" };
const WHSEC = "whsec_test";
const NOW = "2026-10-07T03:00:00.000Z";
const NOW_SEC = Math.floor(Date.parse(NOW) / 1000);
const SITE = "hokuriku-it-conf.com";

interface Call {
  url: string;
  method: string;
  idempotencyKey: string | null;
  form: URLSearchParams | null;
}

type RefundReply = { status: number; json: Record<string, unknown> };

/** Checkout create + refund create. `refund` decides how /v1/refunds answers. */
function fakeStripe(refund: () => RefundReply = () => ({ status: 200, json: { id: "re_1", status: "succeeded", amount: 3000 } }), key = "sk_test_123") {
  const calls: Call[] = [];
  let n = 0;
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const form = typeof init?.body === "string" ? new URLSearchParams(init.body) : null;
    calls.push({ url, method: init?.method ?? "GET", idempotencyKey: headers.get("idempotency-key"), form });
    if (url.endsWith("/refunds")) {
      const r = refund();
      return Response.json(r.json, { status: r.status });
    }
    const id = `cs_test_${n++}`;
    return Response.json({ id, url: `https://checkout.stripe.com/${id}`, status: "open", payment_status: "unpaid", client_reference_id: form?.get("client_reference_id"), livemode: false });
  };
  return { calls, client: createStripeClient(key, fetchFn) };
}

async function webhook(app: Awaited<ReturnType<typeof makeApp>>["app"], event: Record<string, unknown>) {
  const raw = JSON.stringify({ livemode: false, ...event });
  return app.fetch(
    new Request("https://lp/lp/internal/tickets/stripe-webhook", {
      method: "POST",
      headers: { ...INTERNAL, "stripe-signature": await signStripePayload(raw, WHSEC, NOW_SEC), "content-type": "application/json" },
      body: raw,
    }),
  );
}

const checkout = (b: Record<string, unknown>) =>
  send(
    "POST",
    "/lp/internal/tickets/checkout",
    { name: "山田 太郎", email: "taro@example.com", answers: {}, origin: "https://hokuriku-it-conf.com", ...b },
    INTERNAL,
  );

const refundReq = (id: string) => send("POST", `/lp/tickets/orders/${id}/refund`, {});

/** Records every mail; refundMails() = the buyer refund notices only. */
function recordingMailer() {
  const sent: { mail: OutboundMail; key: string }[] = [];
  const mailer: Mailer = {
    send: async (mail, key) => {
      sent.push({ mail, key });
      return { ok: true, id: `re_${sent.length}` };
    },
  };
  return { mailer, sent, refundMails: () => sent.filter((s) => s.key.endsWith(":buyer_refund")) };
}

const chargeRefunded = (pi: string) => ({
  id: `evt_refunded_${pi}`,
  type: "charge.refunded",
  data: { object: { id: "ch_1", payment_intent: pi, amount: 3000, amount_refunded: 3000, livemode: false } },
});

describe.each<RepoKind>(["memory", "d1"])("lp tickets refund (%s repo)", (kind) => {
  async function setup(
    opts: { stripe?: ReturnType<typeof fakeStripe> | null; publish?: boolean; mailer?: Mailer | null; repo?: LpTicketRepo } = {},
  ) {
    const stripe = opts.stripe === undefined ? fakeStripe() : opts.stripe;
    const mail = recordingMailer();
    // The send right after a refund runs in waitUntil (defer); every request here waits for it.
    const deferred: Promise<unknown>[] = [];
    const h = await makeApp(kind, "edit", opts.publish === false ? [] : ["lp:publish"], {
      stripe: stripe ? stripe.client : null,
      stripeWebhookSecret: WHSEC,
      mailer: opts.mailer === undefined ? mail.mailer : opts.mailer,
      defer: (p) => void deferred.push(p),
      ...(opts.repo ? { repo: opts.repo } : {}),
    });
    const rawFetch = h.app.fetch.bind(h.app);
    h.app.fetch = (async (...a: Parameters<typeof rawFetch>) => {
      const res = await rawFetch(...a);
      while (deferred.length > 0) await Promise.all(deferred.splice(0));
      return res;
    }) as typeof h.app.fetch;
    expect((await h.app.fetch(send("POST", "/lp/tickets/enabled", { enabled: true }))).status).toBe(200);
    const res = await h.app.fetch(send("POST", "/lp/tickets/types", { name: "一般", description: "", priceJpy: 3000, capacity: 2, active: true }));
    const t = await body<LpTicketTypeSummary>(res);
    /** A paid (Stripe) order settled by checkout.session.completed. */
    const buyPaid = async (o: Record<string, unknown> = {}) => {
      expect((await h.app.fetch(checkout({ items: [{ ticketTypeId: t.id, quantity: 1 }] }))).status).toBe(200);
      const c = stripe!.calls.filter((x) => x.url.endsWith("/checkout/sessions")).at(-1)!;
      const orderId = c.form!.get("client_reference_id")!;
      const sid = `cs_test_${stripe!.calls.filter((x) => x.url.endsWith("/checkout/sessions")).length - 1}`;
      await webhook(h.app, {
        id: `evt_${sid}`,
        type: "checkout.session.completed",
        data: {
          object: { id: sid, livemode: false, currency: "jpy", client_reference_id: orderId, payment_status: "paid", status: "complete", amount_total: 3000, payment_intent: `pi_${sid}`, ...o },
        },
      });
      return orderId;
    };
    /** A 0-yen coupon order (paid at once, no Stripe). */
    const buyFree = async () => {
      const cres = await h.app.fetch(send("POST", "/lp/tickets/coupons", { ticketTypeId: t.id, maxUses: 5 }));
      const coupon = await body<LpTicketCoupon>(cres);
      expect((await h.app.fetch(checkout({ items: [{ ticketTypeId: t.id, quantity: 1 }], couponCode: coupon.code }))).status).toBe(200);
      const orders = (await h.repo.listOrders(SITE, null, 50)).filter((o) => o.amountJpy === 0);
      return orders[0]!.id;
    };
    const sold = async () => (await body<{ types: LpTicketTypeSummary[] }>(await h.app.fetch(get("/lp/tickets")))).types[0]!.stats;
    return { ...h, stripe, mail, t, buyPaid, buyFree, sold };
  }

  it("mail: immediate refund sends the refund notice once; the charge.refunded that follows sends nothing", async () => {
    const { app, mail, buyPaid } = await setup();
    const id = await buyPaid();
    expect((await body<LpTicketRefundResponse>(await app.fetch(refundReq(id)))).result).toBe("refunded");
    await webhook(app, chargeRefunded("pi_cs_test_0"));
    await app.fetch(refundReq(id)); // 409, no mail
    const sent = mail.refundMails();
    expect(sent).toHaveLength(1);
    const m = sent[0]!;
    expect(m.key).toBe(`${id}:buyer_refund`);
    expect(m.mail.to).toBe("taro@example.com");
    expect(m.mail.subject).toBe(`【北陸ITカンファレンス 2027】返金（お申し込みの取消）のお知らせ（注文番号 ${id.slice(-8).toUpperCase()}）`);
    expect(m.mail.text).toContain(`注文番号: ${id.slice(-8).toUpperCase()}`);
    expect(m.mail.text).toContain("返金額: ¥3,000");
    expect(m.mail.text).toContain("チケットはすべて無効");
    expect(m.mail.text).toContain("カード会社");
    expect(m.mail.text).not.toContain("/t/");
    expect(m.mail.html).toContain("返金額: <strong>¥3,000</strong>");
  });

  it("mail: refund_pending sends nothing until charge.refunded, then exactly once (webhook replay too)", async () => {
    const stripe = fakeStripe(() => ({ status: 200, json: { id: "re_2", status: "pending", amount: 3000 } }));
    const { app, mail, buyPaid } = await setup({ stripe });
    const id = await buyPaid();
    expect((await body<LpTicketRefundResponse>(await app.fetch(refundReq(id)))).result).toBe("refund_pending");
    expect(mail.refundMails()).toHaveLength(0);
    await webhook(app, chargeRefunded("pi_cs_test_0"));
    await webhook(app, chargeRefunded("pi_cs_test_0"));
    expect(mail.refundMails().map((s) => s.key)).toEqual([`${id}:buyer_refund`]);
  });

  it("mail: a refund made in the Stripe dashboard (charge.refunded only) also notifies once", async () => {
    const { app, mail, buyPaid } = await setup();
    const id = await buyPaid();
    await webhook(app, chargeRefunded("pi_cs_test_0"));
    expect(mail.refundMails().map((s) => s.key)).toEqual([`${id}:buyer_refund`]);
  });

  it("mail: free cancel sends the cancel notice once (no refund amount / card note)", async () => {
    const { app, mail, buyFree } = await setup();
    const id = await buyFree();
    expect((await body<LpTicketRefundResponse>(await app.fetch(refundReq(id)))).result).toBe("cancelled");
    await app.fetch(refundReq(id));
    const sent = mail.refundMails();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.mail.subject).toContain("お申し込みの取消のお知らせ");
    expect(sent[0]!.mail.text).toContain("お支払い: なし（無料）");
    expect(sent[0]!.mail.text).not.toContain("返金額");
    expect(sent[0]!.mail.text).not.toContain("カード会社");
  });

  it("mail: a failed send never fails the refund", async () => {
    const { app, repo, buyFree } = await setup();
    const id = await buyFree();
    const broken = await makeApp(kind, "edit", ["lp:publish"], {
      repo,
      mailer: { send: async () => ({ ok: false, failure: "transient", error: "down" }) },
    });
    expect((await broken.app.fetch(refundReq(id))).status).toBe(200);
    expect((await repo.getOrder(SITE, id))!.status).toBe("refunded");
  });

  const refundRows = async (repo: LpTicketRepo, id: string): Promise<OutboxRow[]> =>
    (await repo.listOrderOutbox(id)).filter((r) => r.kind === "buyer_refund");
  /** Order mails go out; the refund notice is held (Resend down), so its queued row stays visible. */
  const refundHeld: Mailer = {
    send: async (_m, key) =>
      key.endsWith(":buyer_refund") ? { ok: false, failure: "transient", error: "resend_down" } : { ok: true, id: "re_order" },
  };
  const queuedOnce = async (repo: LpTicketRepo, id: string) => {
    const rows = await refundRows(repo, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: `${id}:buyer_refund`, orderId: id, kind: "buyer_refund", status: "pending", attempts: 0, createdAt: NOW });
  };

  it("outbox: each of the 3 refund paths queues the notice exactly once, in the refund itself (UNIQUE + changes() guard)", async () => {
    const stripe = fakeStripe(() => ({ status: 200, json: { id: "re_3", status: "pending", amount: 3000 } }));
    const { app, repo, buyPaid, buyFree } = await setup({ stripe, mailer: refundHeld });
    // 1) 0 円の取消
    const free = await buyFree();
    expect((await body<LpTicketRefundResponse>(await app.fetch(refundReq(free)))).result).toBe("cancelled");
    await app.fetch(refundReq(free)); // 409
    await queuedOnce(repo, free);
    // 2) charge.refunded（refund_pending の後・リプレイ込み）
    const late = await buyPaid();
    expect((await body<LpTicketRefundResponse>(await app.fetch(refundReq(late)))).result).toBe("refund_pending");
    expect(await refundRows(repo, late)).toEqual([]);
    await webhook(app, chargeRefunded("pi_cs_test_0"));
    await webhook(app, chargeRefunded("pi_cs_test_0"));
    await queuedOnce(repo, late);
  });

  it("outbox: an immediate Stripe refund queues once; the charge.refunded that follows adds nothing", async () => {
    const { app, repo, buyPaid } = await setup({ mailer: refundHeld });
    const id = await buyPaid();
    expect((await body<LpTicketRefundResponse>(await app.fetch(refundReq(id)))).result).toBe("refunded");
    await webhook(app, chargeRefunded("pi_cs_test_0"));
    await queuedOnce(repo, id);
  });

  it("outbox: a lost chargeback refunds the order without a refund notice (and a later charge.refunded adds none)", async () => {
    const { app, repo, buyPaid } = await setup();
    const id = await buyPaid();
    const dispute = (type: string, status?: string) => ({
      id: `evt_${type}_${status ?? ""}`,
      type,
      data: { object: { id: "dp_1", charge: "ch_1", payment_intent: "pi_cs_test_0", livemode: false, ...(status ? { status } : {}) } },
    });
    await webhook(app, dispute("charge.dispute.created"));
    await webhook(app, dispute("charge.dispute.closed", "lost"));
    expect((await repo.getOrder(SITE, id))!.status).toBe("refunded");
    expect(await refundRows(repo, id)).toEqual([]);
    // A charge.refunded that arrives after it changes nothing, so it queues nothing either.
    await webhook(app, chargeRefunded("pi_cs_test_0"));
    expect(await refundRows(repo, id)).toEqual([]);
  });

  it("retry: a failed send stays pending and the drain sends it later with the same Idempotency-Key", async () => {
    const replies: MailResult[] = [];
    const keys: string[] = [];
    const flaky: Mailer = {
      send: async (_m, key) => {
        keys.push(key);
        return replies.shift() ?? { ok: true, id: "re_ok" };
      },
    };
    const { app, repo, clock, deps, buyFree } = await setup({ mailer: flaky });
    const id = await buyFree();
    keys.length = 0;
    replies.push({ ok: false, failure: "transient", error: "resend_5xx" });
    expect((await app.fetch(refundReq(id))).status).toBe(200); // the immediate send fails; the refund does not
    const [row] = await refundRows(repo, id);
    expect(row).toMatchObject({ status: "pending", attempts: 0, lastError: "resend_5xx" });
    expect(Date.parse(row!.nextAttemptAt) - Date.parse(NOW)).toBe(OUTBOX_TRANSIENT_RETRY_MS);
    const delivery = new TicketDelivery(deps);
    expect((await delivery.drainPass()).mailSent).toBe(0); // not due yet
    clock.set(new Date(Date.parse(NOW) + OUTBOX_TRANSIENT_RETRY_MS).toISOString());
    expect((await delivery.drainPass()).mailSent).toBe(1);
    expect((await refundRows(repo, id))[0]).toMatchObject({ status: "sent", lastError: null });
    expect(keys).toEqual([`${id}:buyer_refund`, `${id}:buyer_refund`]);
    expect((await delivery.drainPass()).mailSent).toBe(0); // sent once, never again
  });

  it("retry: refusals back off and give up after the same max attempts as the other mails", async () => {
    let calls = 0;
    const refusing: Mailer = {
      send: async (_m, key) => {
        if (!key.endsWith(":buyer_refund")) return { ok: true, id: "re_confirm" };
        calls++;
        return { ok: false, failure: "rejected", error: "resend_422" };
      },
    };
    const { app, repo, clock, deps, buyFree } = await setup({ mailer: refusing });
    const id = await buyFree();
    await app.fetch(refundReq(id));
    const delivery = new TicketDelivery(deps);
    let t = Date.parse(NOW);
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) {
      t += 2 * 60 * 60 * 1000;
      clock.set(new Date(t).toISOString());
      await delivery.drainPass();
    }
    expect((await refundRows(repo, id))[0]).toMatchObject({ status: "failed", attempts: OUTBOX_MAX_ATTEMPTS, lastError: "resend_422" });
    expect(calls).toBe(OUTBOX_MAX_ATTEMPTS);
  });

  if (kind === "d1") {
    it("before db/0004: the refund still goes through; the notice is not queued (the kind CHECK skips the row)", async () => {
      const { db } = memoryD1();
      await db.exec(INIT_SQL);
      await db.exec(DELIVERY_SQL);
      await db.exec(CHECKIN_SQL);
      const old = createD1TicketRepo(createDbClient(db, { namespace: "lp" }));
      const { app, repo, buyFree } = await setup({ repo: old });
      const id = await buyFree();
      expect((await body<LpTicketRefundResponse>(await app.fetch(refundReq(id)))).result).toBe("cancelled");
      expect((await repo.getOrder(SITE, id))!.status).toBe("refunded");
      expect(await refundRows(repo, id)).toEqual([]);
    });
  }

  it("deadline: open until the last event day 23:59:59.999 JST, 409 refund_window_closed from 00:00 the day after", async () => {
    expect(lpTickets.LP_TICKET_REFUND_CLOSES_AT).toBe("2027-09-14T15:00:00.000Z");
    const { app, clock, repo, stripe, mail, buyPaid, buyFree } = await setup();
    const a = await buyPaid();
    const c = await buyFree();
    clock.set("2027-09-14T14:59:59.999Z"); // 9/14 23:59:59.999 JST
    expect((await body<LpTicketRefundResponse>(await app.fetch(refundReq(a)))).result).toBe("refunded");
    clock.set("2027-09-14T15:00:00.000Z"); // 9/15 00:00 JST
    const res = await app.fetch(refundReq(c));
    expect(res.status).toBe(409);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("refund_window_closed");
    expect(text).toContain("2027-09-14T15:00:00.000Z");
    expect((await repo.getOrder(SITE, c))!.status).toBe("paid");
    expect(stripe!.calls.filter((x) => x.url.endsWith("/refunds"))).toHaveLength(1);
    expect(mail.refundMails()).toHaveLength(1);
  });

  it("paid order: Stripe refund (idempotency key refund:<id>) succeeded → refunded, tickets void, seat freed", async () => {
    const { app, repo, stripe, buyPaid, sold } = await setup();
    const id = await buyPaid();
    expect((await repo.ticketsForOrders([id])).map((t) => t.status)).toEqual(["valid"]);

    const res = await app.fetch(refundReq(id));
    expect(res.status).toBe(200);
    const out = await body<LpTicketRefundResponse>(res);
    expect(out.result).toBe("refunded");
    expect(out.order).toMatchObject({ id, status: "refunded" });
    expect(out.order).not.toHaveProperty("paymentIntentId");

    const call = stripe!.calls.find((c) => c.url.endsWith("/refunds"))!;
    expect(call.idempotencyKey).toBe(`refund:${id}`);
    expect(call.form!.get("payment_intent")).toBe("pi_cs_test_0");
    expect(call.form!.get("metadata[order_id]")).toBe(id);
    expect((await repo.ticketsForOrders([id])).map((t) => t.status)).toEqual(["void"]);
    expect(await sold()).toMatchObject({ sold: 0, revenueJpy: 0, remaining: 2 });

    // the charge.refunded webhook that follows is a no-op (no double transition)
    await webhook(app, {
      id: "evt_refunded",
      type: "charge.refunded",
      data: { object: { id: "ch_1", payment_intent: "pi_cs_test_0", amount: 3000, amount_refunded: 3000, livemode: false } },
    });
    expect(await repo.getOrder(SITE, id)).toMatchObject({ status: "refunded", refundedAt: NOW });
    // a second click is refused (already refunded) and never reaches Stripe again
    const again = await app.fetch(refundReq(id));
    expect(again.status).toBe(409);
    expect(JSON.stringify(await again.json())).toContain("not_refundable");
    expect(stripe!.calls.filter((c) => c.url.endsWith("/refunds"))).toHaveLength(1);
  });

  it("paid order: Stripe refund pending → order unchanged (refund_pending); charge.refunded webhook finishes it", async () => {
    const stripe = fakeStripe(() => ({ status: 200, json: { id: "re_2", status: "pending", amount: 3000 } }));
    const { app, repo, buyPaid } = await setup({ stripe });
    const id = await buyPaid();
    const out = await body<LpTicketRefundResponse>(await app.fetch(refundReq(id)));
    expect(out).toMatchObject({ result: "refund_pending", order: { id, status: "paid" } });
    expect((await repo.ticketsForOrders([id])).map((t) => t.status)).toEqual(["valid"]);
    await webhook(app, {
      id: "evt_refunded",
      type: "charge.refunded",
      data: { object: { id: "ch_1", payment_intent: "pi_cs_test_0", amount: 3000, amount_refunded: 3000, livemode: false } },
    });
    expect((await repo.getOrder(SITE, id))!.status).toBe("refunded");
    expect((await repo.ticketsForOrders([id])).map((t) => t.status)).toEqual(["void"]);
  });

  it("free (0 yen) order: cancelled on the spot, Stripe never called, tickets void", async () => {
    const { app, repo, stripe, buyFree, sold } = await setup();
    const id = await buyFree();
    const out = await body<LpTicketRefundResponse>(await app.fetch(refundReq(id)));
    expect(out).toMatchObject({ result: "cancelled", order: { id, status: "refunded", amountJpy: 0 } });
    expect(stripe!.calls.some((c) => c.url.endsWith("/refunds"))).toBe(false);
    expect((await repo.ticketsForOrders([id])).every((t) => t.status === "void")).toBe(true);
    expect(await sold()).toMatchObject({ sold: 0, remaining: 2 });
  });

  it("free order can be cancelled even without Stripe configured", async () => {
    const { app, buyFree } = await setup({ stripe: null });
    const id = await buyFree();
    expect((await body<LpTicketRefundResponse>(await app.fetch(refundReq(id)))).result).toBe("cancelled");
  });

  it("needs lp:publish (edit alone 403); unknown 404; pending 409 not_refundable", async () => {
    const { app, repo, buyPaid, t } = await setup();
    const id = await buyPaid();
    const editOnly = await makeApp(kind, "edit", [], { repo });
    expect((await editOnly.app.fetch(refundReq(id))).status).toBe(403);
    expect((await app.fetch(refundReq("tko_nope"))).status).toBe(404);
    expect((await app.fetch(checkout({ items: [{ ticketTypeId: t.id, quantity: 1 }] }))).status).toBe(200);
    const pending = (await repo.listOrders(SITE, null, 50)).find((o) => o.status === "pending")!;
    const res = await app.fetch(refundReq(pending.id));
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain("not_refundable");
  });

  it("needs_review: oversold / amount_mismatch can be refunded; an open dispute cannot", async () => {
    const { app, repo, stripe, buyPaid } = await setup();
    const mismatch = await buyPaid({ amount_total: 300 });
    expect((await repo.getOrder(SITE, mismatch))!.status).toBe("needs_review");
    expect((await body<LpTicketRefundResponse>(await app.fetch(refundReq(mismatch)))).result).toBe("refunded");

    const disputed = await buyPaid();
    await webhook(app, {
      id: "evt_dp",
      type: "charge.dispute.created",
      data: { object: { id: "dp_1", payment_intent: "pi_cs_test_1", livemode: false } },
    });
    const res = await app.fetch(refundReq(disputed));
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain("dispute_open");
    expect(stripe!.calls.filter((c) => c.url.endsWith("/refunds"))).toHaveLength(1);
  });

  it("Stripe 4xx (e.g. charge_already_refunded) → 409 refund_rejected, order unchanged", async () => {
    const stripe = fakeStripe(() => ({ status: 400, json: { error: { code: "charge_already_refunded", message: "x" } } }));
    const { app, repo, buyPaid } = await setup({ stripe });
    const id = await buyPaid();
    const res = await app.fetch(refundReq(id));
    expect(res.status).toBe(409);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("refund_rejected");
    expect(text).toContain("charge_already_refunded");
    expect((await repo.getOrder(SITE, id))!.status).toBe("paid");
  });

  it("Stripe 5xx → upstream error (retryable), order unchanged", async () => {
    const stripe = fakeStripe(() => ({ status: 500, json: {} }));
    const { app, repo, buyPaid } = await setup({ stripe });
    const id = await buyPaid();
    const res = await app.fetch(refundReq(id));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect((await repo.getOrder(SITE, id))!.status).toBe("paid");
  });

  it("paid order without payment_intent → 409 payment_intent_missing; Stripe gone → 503", async () => {
    const { app, repo, buyPaid } = await setup();
    const id = await buyPaid({ payment_intent: null });
    expect((await repo.getOrder(SITE, id))!.paymentIntentId).toBeNull();
    const res = await app.fetch(refundReq(id));
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain("payment_intent_missing");

    const noStripe = await makeApp(kind, "edit", ["lp:publish"], { repo, stripe: null });
    expect((await noStripe.app.fetch(refundReq(id))).status).toBe(503);
  });

  it("a test-mode order is not refunded with a live key (stripe_mode_mismatch)", async () => {
    const { repo, buyPaid } = await setup();
    const id = await buyPaid();
    const live = fakeStripe(undefined, "sk_live_x");
    const liveApp = await makeApp(kind, "edit", ["lp:publish"], { repo, stripe: live.client });
    const res = await liveApp.app.fetch(refundReq(id));
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain("stripe_mode_mismatch");
    expect(live.calls).toHaveLength(0);
  });
});
