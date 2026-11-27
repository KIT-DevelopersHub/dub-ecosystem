// チケット購入 → 決済（Stripe テストモード）→ 発券（確認メール・チケット URL・QR）→ 当日受付 の E2E（#897）。
// ここが壊れるのが一番致命的なので、毎 PR の `pnpm test` で回す（node:sqlite・外部通信なし・数百 ms）。
// スタックの中身と偽物の範囲は src/ticket-stack.ts。ブラウザ版は apps/fe2-app-shell/e2e/ticket-to-checkin.spec.ts。
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach } from "vitest";
import type { lpTickets } from "@dub/types";
import { ticketsSchemas } from "../src/d1";
import { createTicketStack, STAFF, TEST_CARD_DECLINED, TEST_CARD_OK, type TicketStack } from "../src/ticket-stack";

type LpTicketCoupon = lpTickets.LpTicketCoupon;
type LpTicketOrdersPage = lpTickets.LpTicketOrdersPage;
type LpTicketTypeSummary = lpTickets.LpTicketTypeSummary;

const EVENT_DAY = "2027-03-06";

let s: TicketStack;
let paidType: LpTicketTypeSummary;
let freeType: LpTicketTypeSummary;

beforeEach(async () => {
  s = await createTicketStack();
  // LP管理: 券種（有料の通し券・無料の招待券）を作り、販売を on にする。
  paidType = await s.admin("POST", "/lp/tickets/types", { name: "一般", description: "", priceJpy: 3000, capacity: 100, active: true, dayLabel: "" });
  freeType = await s.admin("POST", "/lp/tickets/types", { name: "招待", description: "", priceJpy: 0, capacity: 20, active: true, dayLabel: "" });
  await s.admin("POST", "/lp/tickets/enabled", { enabled: true });
});

const buyer = (extra: Record<string, string>) => ({ name: "北陸 花子", email: "hanako@example.com", ...extra });
const location = (res: Response) => res.headers.get("location") ?? "";
const html = async (res: Response) => {
  expect(res.status).toBe(200);
  return res.text();
};

/** 購入者宛ての確認メール（運営の控えは除く）。 */
const buyerMails = () => s.mails.filter((m) => m.to === "hanako@example.com");

async function buyPaid(qty = 1) {
  const res = await s.submitCheckout(buyer({ [`qty_${paidType.id}`]: String(qty) }));
  expect(res.status).toBe(303);
  const checkoutUrl = location(res);
  expect(checkoutUrl.startsWith(`${s.checkoutOrigin}/c/pay/cs_test_`)).toBe(true);
  return checkoutUrl.split("/").pop()!;
}

describe("ticket purchase -> payment -> ticket -> check-in (#897)", () => {
  it("paid: LP form -> Stripe test checkout (4242) -> signed webhook -> ticket mail + QR -> check-in once", async () => {
    // 1) 公開 LP: 券種が見えて、フォーム送信で Stripe Checkout へ飛ぶ。
    const page = await html(await s.lp(new Request(`${s.lpOrigin}/tickets`)));
    expect(page).toContain("一般");
    const sessionId = await buyPaid(1);
    expect(s.stripeCalls.every((c) => c.auth === "Bearer sk_test_e2e_not_a_real_key")).toBe(true);

    // 2) テストカードで支払う → 署名付き webhook → 注文が paid、券が発行される。
    const paid = await s.pay(sessionId, TEST_CARD_OK);
    expect(paid.webhook?.status).toBe(200);
    const orders = await s.admin<LpTicketOrdersPage>("GET", "/lp/tickets/orders");
    expect(orders.items).toHaveLength(1);
    expect(orders.items[0]).toMatchObject({ status: "paid", amountJpy: 3000 });

    // 3) 完了ページ（success_url）: サーバー側で確認して「完了」を出す。
    const thanks = await html(await s.lp(new Request(paid.redirectTo!)));
    expect(thanks).toContain("お申し込みが完了しました");

    // 4) 確認メールにチケット URL（= QR の中身）。チケットページと QR 画像が開ける。
    expect(buyerMails()).toHaveLength(1);
    const [ticketUrl] = s.ticketUrlsIn(buyerMails()[0]!);
    expect(ticketUrl).toBeDefined();
    const pass = await html(await s.lp(new Request(ticketUrl!)));
    expect(pass).toContain("VALID");
    const qr = await s.lp(new Request(`${ticketUrl}/qr.png`));
    expect(qr.status).toBe(200);
    expect(qr.headers.get("content-type")).toBe("image/png");

    // 5) 当日受付: QR を読む（中身は ticketUrl）→ ok。もう一度読むと already（二重受付は拒否）。
    const first = await s.checkin(ticketUrl!, EVENT_DAY);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ result: "ok", eventDay: EVENT_DAY, checkedInBy: STAFF.reception });
    const again = await s.checkin(ticketUrl!, EVENT_DAY);
    expect(again.body).toMatchObject({ result: "already", checkedInAt: first.body.checkedInAt });
  });

  it("free: coupon -> 0 yen order without Stripe -> ticket mail -> check-in by order number, double rejected", async () => {
    const coupon = await s.admin<LpTicketCoupon>("POST", "/lp/tickets/coupons", { ticketTypeId: freeType.id, maxUses: 5 });
    const res = await s.submitCheckout(buyer({ couponCode: coupon.code, [`qty_${freeType.id}`]: "1" }));
    expect(res.status).toBe(303);
    const thanksUrl = location(res);
    expect(thanksUrl).toMatch(/\/tickets\/thanks\?order=tko_/);
    expect(s.stripeCalls).toHaveLength(0); // 0 円は Stripe を通らない
    expect(await html(await s.lp(new Request(thanksUrl)))).toContain("お申し込みが完了しました");

    const [ticketUrl] = s.ticketUrlsIn(buyerMails()[0]!);
    expect(ticketUrl).toBeDefined();
    // 手入力: 注文番号（注文 ID の末尾 8 文字）。1 枚の注文なら枚目は省略できる。
    const orderId = new URL(thanksUrl).searchParams.get("order")!;
    const ref = orderId.slice(-8);
    expect((await s.checkin(ref, EVENT_DAY)).body).toMatchObject({ result: "ok" });
    expect((await s.checkin(ticketUrl!, EVENT_DAY)).body).toMatchObject({ result: "already" });
  });

  it("multi-ticket order: each ticket checks in on its own", async () => {
    const sessionId = await buyPaid(2);
    await s.pay(sessionId, TEST_CARD_OK);
    const urls = s.ticketUrlsIn(buyerMails()[0]!);
    expect(urls).toHaveLength(2);
    expect((await s.checkin(urls[0]!, EVENT_DAY)).body.result).toBe("ok");
    expect((await s.checkin(urls[1]!, EVENT_DAY)).body.result).toBe("ok");
    expect((await s.checkin(urls[0]!, EVENT_DAY)).body.result).toBe("already");
  });

  it("declined card: no webhook, order stays pending, no ticket is issued", async () => {
    const sessionId = await buyPaid(1);
    const r = await s.pay(sessionId, TEST_CARD_DECLINED);
    expect(r.ok).toBe(false);
    const orders = await s.admin<LpTicketOrdersPage>("GET", "/lp/tickets/orders");
    expect(orders.items[0]).toMatchObject({ status: "pending" });
    expect(buyerMails()).toHaveLength(0);
  });

  it("guards: forged / unknown codes are unknown, the receptionist needs lp:checkin, forged webhooks are refused", async () => {
    const sessionId = await buyPaid(1);
    await s.pay(sessionId, TEST_CARD_OK);
    const [ticketUrl] = s.ticketUrlsIn(buyerMails()[0]!);
    const forged = ticketUrl!.replace(/\.[A-Za-z0-9_-]{24}$/, ".AAAAAAAAAAAAAAAAAAAAAAAA");
    expect((await s.checkin(forged, EVENT_DAY)).body.result).toBe("unknown");
    expect((await s.checkin("NOPE0000", EVENT_DAY)).body.result).toBe("unknown");
    // 権限の無い利用者は 403（受付画面からは入れない）。
    expect((await s.checkin(ticketUrl!, EVENT_DAY, "usr_e2e_nobody")).status).toBe(403);
    // 署名が違う webhook は 400（偽の「支払い済み」で券を出させない）。
    const ev = await s.webhookEvent("checkout.session.completed", { ...s.sessions.get(sessionId)! });
    expect((await s.postWebhook(ev.raw, ev.signature.replace(/v1=[0-9a-f]+/, "v1=00"))).status).toBe(400);
  });
});

describe("recovery paths (runbook docs/runbooks/10-ticket-flow-e2e-and-rollback.md)", () => {
  it("webhook lost: the reconcile pass (cron) settles the order from Stripe and issues the ticket", async () => {
    const sessionId = await buyPaid(1);
    const r = await s.pay(sessionId, TEST_CARD_OK, { deliverWebhook: false });
    expect(r.ok).toBe(true);
    expect(buyerMails()).toHaveLength(0);
    s.advance(6 * 60 * 1000); // reconcile は 5 分より古い pending だけを見る
    const sum = await s.reconcile();
    expect(sum.paid).toBe(1);
    const [ticketUrl] = s.ticketUrlsIn(buyerMails()[0]!);
    expect((await s.checkin(ticketUrl!, EVENT_DAY)).body.result).toBe("ok");
  });

  it("webhook lost: the thanks page (success_url) settles it too", async () => {
    const sessionId = await buyPaid(1);
    const r = await s.pay(sessionId, TEST_CARD_OK, { deliverWebhook: false });
    expect(await html(await s.lp(new Request(r.redirectTo!)))).toContain("お申し込みが完了しました");
    expect(buyerMails()).toHaveLength(1);
  });

  it("webhook resent (Stripe dashboard / retry): idempotent, no second ticket or mail", async () => {
    const sessionId = await buyPaid(1);
    const r = await s.pay(sessionId, TEST_CARD_OK);
    expect((await s.postWebhook(r.webhook!.raw, r.webhook!.signature)).status).toBe(200);
    const ev = await s.webhookEvent("checkout.session.completed", s.sessions.get(sessionId)!);
    expect((await s.postWebhook(ev.raw, ev.signature)).status).toBe(200);
    expect(buyerMails()).toHaveLength(1);
    expect(s.ticketUrlsIn(buyerMails()[0]!)).toHaveLength(1);
  });

  it("refunded order: its ticket is void at the door", async () => {
    const sessionId = await buyPaid(1);
    await s.pay(sessionId, TEST_CARD_OK);
    const [ticketUrl] = s.ticketUrlsIn(buyerMails()[0]!);
    const orders = await s.admin<LpTicketOrdersPage>("GET", "/lp/tickets/orders");
    await s.admin("POST", `/lp/tickets/orders/${orders.items[0]!.id}/refund`);
    expect((await s.checkin(ticketUrl!, EVENT_DAY)).body.result).toBe("void");
  });
});

describe("stack guards", () => {
  it("refuses a live Stripe key", async () => {
    await expect(createTicketStack({ stripeSecretKey: "sk_live_x" })).rejects.toThrow(/TEST mode only/);
    await expect(createTicketStack({ stripeSecretKey: "rk_live_x" })).rejects.toThrow(/TEST mode only/);
  });

  it("applies every dub-tickets migration (add new services/lp-tickets/db/*.sql to src/d1.ts ticketsSchemas)", () => {
    const dir = fileURLToPath(new URL("../../../services/lp-tickets/db/", import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql"));
    expect(ticketsSchemas()).toHaveLength(files.length);
  });
});
