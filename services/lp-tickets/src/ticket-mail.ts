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

/** receiptUrl: 有料注文だけ（無料・未設定は null でリンクを出さない）。 */
export function renderBuyerMail(order: TicketOrderRow, passes: readonly TicketPass[], receiptUrl: string | null = null): RenderedMail {
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
    ...(receiptUrl ? [`領収書（宛名を入れて印刷できます）: ${receiptUrl}`] : []),
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
    `合計: ${esc(yen(order.amountJpy))}` +
    (receiptUrl ? `<br><a href="${esc(receiptUrl)}">領収書を表示する</a>（宛名を入れて印刷できます）` : "") +
    "</p>" +
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

/**
 * 返金・取消の完了通知（購入者あて）。チケット URL は入れない（もう無効なので）。
 * 0 円の注文は「取消」、有料は「返金」の文面にする。
 */
export function renderRefundMail(order: TicketOrderRow): RenderedMail {
  const number = orderNumber(order.id);
  const free = order.amountJpy === 0;
  const test = isTestOrder(order);
  const items = order.items.map((i) => `${ticketName(i)} × ${i.quantity} 枚`);
  const lead = free
    ? `${EVENT_NAME} のお申し込みを取り消しました。`
    : `${EVENT_NAME} のお申し込みを取り消し、お支払いいただいた代金を返金しました。`;
  const notes = [
    "このご注文のチケットはすべて無効になりました。当日の受付ではご利用いただけません。",
    ...(free
      ? []
      : [
          "返金はお支払いに使われたカード・決済サービスへ行います。",
          "ご利用明細や口座へ反映される時期は、カード会社・決済サービスによって異なります（数日〜翌月以降になることがあります）。",
        ]),
    "お心当たりのない場合は、このメールへの返信でお知らせください。",
  ];
  const testNote = "これはテスト購入です。実際の請求・返金はありません。";
  const text = [
    `${order.buyerName} 様`,
    "",
    lead,
    ...(test ? ["", testNote] : []),
    "",
    `注文番号: ${number}`,
    "ご注文内容:",
    ...items.map((i) => `  ${i}`),
    free ? "お支払い: なし（無料）" : `返金額: ${yen(order.amountJpy)}`,
    "",
    ...notes,
    "",
    `${EVENT_NAME} 事務局`,
  ].join("\n");
  const html =
    '<div style="font-family:sans-serif;color:#1a2238;line-height:1.7;max-width:560px;margin:0 auto">' +
    `<p>${esc(order.buyerName)} 様</p>` +
    `<p>${esc(lead)}</p>` +
    (test ? `<p><strong>${testNote}</strong></p>` : "") +
    `<p>注文番号: <strong>${esc(number)}</strong><br>` +
    items.map((i) => `${esc(i)}<br>`).join("") +
    (free ? "お支払い: なし（無料）" : `返金額: <strong>${esc(yen(order.amountJpy))}</strong>`) +
    "</p>" +
    `<p>${notes.map(esc).join("<br>")}</p>` +
    `<p>${EVENT_NAME} 事務局</p></div>`;
  const title = free ? "お申し込みの取消のお知らせ" : "返金（お申し込みの取消）のお知らせ";
  return { subject: `【${EVENT_NAME}】${title}（注文番号 ${number}）`, text, html };
}
