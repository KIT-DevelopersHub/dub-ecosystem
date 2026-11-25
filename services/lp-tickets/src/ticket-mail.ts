// 購入後のメール本文（純粋関数）。buyer_confirmation はチケット URL を含み、ops_copy は含まない。
import type { TicketOrderRow, TicketRow } from "./types";

export const EVENT_NAME = "北陸ITカンファレンス 2027";

/** Preview orders, or paid through Stripe test mode (cs_test_): no real charge. */
export const isTestOrder = (o: Pick<TicketOrderRow, "preview" | "stripeSessionId">): boolean =>
  o.preview || (o.stripeSessionId?.startsWith("cs_test_") ?? false);

/** The number people read out: the random tail of the order id. */
export const orderNumber = (orderId: string): string => orderId.slice(-8).toUpperCase();

export interface TicketPass {
  ticket: TicketRow;
  url: string;
  qrUrl: string;
}

export interface RenderedMail {
  subject: string;
  text: string;
  html?: string;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const yen = (n: number): string => (n === 0 ? "無料" : `¥${n.toLocaleString("ja-JP")}`);
const ticketName = (t: { ticketTypeName: string; dayLabel: string }): string =>
  t.dayLabel ? `${t.ticketTypeName}（${t.dayLabel}）` : t.ticketTypeName;

const SHARE_NOTE = [
  "チケットの URL は 1 枚ごとに異なり、URL を知っている人なら誰でも使えます。",
  "同行者の方には、その方の分の URL だけを転送してください。SNS などには公開しないでください。",
];

export function renderBuyerMail(order: TicketOrderRow, passes: readonly TicketPass[]): RenderedMail {
  const number = orderNumber(order.id);
  const items = order.items.map((i) => `${ticketName(i)} × ${i.quantity} 枚（${yen(i.unitPriceJpy)}）`);
  const test = isTestOrder(order);
  const testNote = "これはテスト購入です。実際の請求はありません。";
  const text = [
    `${order.buyerName} 様`,
    "",
    `${EVENT_NAME} のチケットをお申し込みいただき、ありがとうございます。`,
    ...(test ? ["", testNote] : []),
    "",
    `注文番号: ${number}`,
    "ご注文内容:",
    ...items.map((i) => `  ${i}`),
    `合計: ${yen(order.amountJpy)}`,
    "",
    "チケット:",
    ...passes.map((p, i) => `  ${i + 1}. ${ticketName(p.ticket)}: ${p.url}`),
    "",
    ...SHARE_NOTE,
    "",
    `${EVENT_NAME} 事務局`,
  ].join("\n");
  const html =
    '<div style="font-family:sans-serif;color:#1a2238;line-height:1.7;max-width:560px;margin:0 auto">' +
    `<p>${esc(order.buyerName)} 様</p>` +
    `<p>${EVENT_NAME} のチケットをお申し込みいただき、ありがとうございます。</p>` +
    (test ? `<p><strong>${testNote}</strong></p>` : "") +
    `<p>注文番号: <strong>${esc(number)}</strong><br>` +
    items.map((i) => `${esc(i)}<br>`).join("") +
    `合計: ${esc(yen(order.amountJpy))}</p>` +
    passes
      .map(
        (p, i) =>
          '<div style="border:1px solid #d8deea;border-radius:12px;padding:16px;margin:16px 0;text-align:center">' +
          `<p style="margin:0 0 8px"><strong>${i + 1}. ${esc(ticketName(p.ticket))}</strong></p>` +
          `<img src="${esc(p.qrUrl)}" width="200" height="200" alt="チケットの QR コード"><br>` +
          `<a href="${esc(p.url)}">チケットを開く</a></div>`,
      )
      .join("") +
    `<p>${SHARE_NOTE.join("<br>")}</p>` +
    `<p>${EVENT_NAME} 事務局</p></div>`;
  return { subject: `【${EVENT_NAME}】チケットのご案内（注文番号 ${number}）`, text, html };
}

/** Purchase record for the organisers. Must never carry a ticket URL or token. */
export function renderOpsMail(order: TicketOrderRow): RenderedMail {
  const text = [
    `注文番号: ${orderNumber(order.id)}`,
    `注文 ID: ${order.id}`,
    `状態: ${order.status}`,
    `購入者: ${order.buyerName}`,
    `メール: ${order.buyerEmail}`,
    "明細:",
    ...order.items.map((i) => `  ${ticketName(i)} × ${i.quantity} 枚（単価 ${yen(i.unitPriceJpy)}）`),
    `合計枚数: ${order.quantity}`,
    `合計金額: ${yen(order.amountJpy)}`,
    `決済手段: ${order.paymentMethod ?? "-"}`,
    `クーポン: ${order.couponId ?? "-"}`,
    "回答:",
    ...(order.answers.length > 0 ? order.answers.map((a) => `  ${a.label}: ${a.value}`) : ["  なし"]),
    `作成日時: ${order.createdAt}`,
    `支払日時: ${order.paidAt ?? "-"}`,
  ].join("\n");
  return { subject: `[LP チケット] 購入 ${orderNumber(order.id)}`, text };
}
