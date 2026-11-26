// 領収書（純粋関数）。HTML は公開 LP の Worker が描く（/receipt/<token>）。ここは「出してよい注文か」と中身だけ。
import { errors } from "@dub/errors";
import { accounting, lpTickets } from "@dub/types";
import { EVENT_NAME, isTestOrder, orderNumber } from "./ticket-mail";
import type { LpTicketReceipt, LpTicketReceiptIssuer, TicketOrderRow } from "./types";

/**
 * 既定の発行者。会計アプリで発行者情報をまだ保存していない時に使う（LP の alternateName・メールの差出人と同じもの）。
 * 所在地とインボイス登録番号は勝手に埋めない（LP は「未設定」と明示して出す）。
 */
export const RECEIPT_ISSUER: LpTicketReceiptIssuer = {
  name: "一般社団法人 Developers Hub",
  event: EVENT_NAME,
  office: `${EVENT_NAME} 事務局`,
  email: "info@developershub.jp",
  url: "https://developershub.jp",
  address: null,
  phone: null,
  invoiceRegistrationNo: null,
  taxRatePercent: accounting.DEFAULT_TAX_RATE,
};

/** 会計アプリの設定を領収書の発行者欄にする。未設定 (null) は既定のまま。空の任意項目は既定で埋める（連絡先が消えないように）。 */
export function issuerFrom(s: accounting.IssuerSettings | null): LpTicketReceiptIssuer {
  if (!s) return RECEIPT_ISSUER;
  return {
    name: s.name,
    event: EVENT_NAME,
    office: s.officeName ?? RECEIPT_ISSUER.office,
    email: s.email ?? RECEIPT_ISSUER.email,
    url: s.url ?? RECEIPT_ISSUER.url,
    address: accounting.formatIssuerAddress(s),
    phone: s.phone,
    invoiceRegistrationNo: s.invoiceRegistrationNo,
    taxRatePercent: s.taxRatePercent,
  };
}

/** 税込金額からの内税（端数切り捨て）。既定は標準税率 10%。 */
export const taxIncluded = (amountJpy: number, ratePercent: number = accounting.DEFAULT_TAX_RATE): number =>
  accounting.taxIncluded(amountJpy, ratePercent);

/** 領収書を出せる注文: 有料で、支払い済みか返金済み（返金済みは「無効」と明記して出す）。 */
export function receiptAvailable(o: Pick<TicketOrderRow, "status" | "amountJpy" | "paidAt">): boolean {
  return o.amountJpy > 0 && o.paidAt !== null && (o.status === "paid" || o.status === "refunded");
}

export function receiptOf(o: TicketOrderRow, issuer: LpTicketReceiptIssuer = RECEIPT_ISSUER): LpTicketReceipt | null {
  if (!receiptAvailable(o)) return null;
  return {
    orderNumber: orderNumber(o.id),
    status: o.status === "refunded" ? "refunded" : "issued",
    receiptName: o.receiptName ?? null,
    items: o.items.map((i) => ({ ...i })),
    amountJpy: o.amountJpy,
    taxJpy: issuer.invoiceRegistrationNo ? taxIncluded(o.amountJpy, issuer.taxRatePercent) : null,
    paidAt: o.paidAt!,
    paymentMethod: o.paymentMethod,
    test: isTestOrder(o),
    issuer,
  };
}

// 制御文字・改行は宛名に入れさせない（印刷の体裁と HTML の崩れを防ぐ）。
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** 宛名の検査。空・未指定は name null。 */
export function checkReceiptName(raw: unknown): { name: string | null } | { reason: "invalid" | "too_long" } {
  if (raw === undefined || raw === null) return { name: null };
  if (typeof raw !== "string" || CONTROL_RE.test(raw)) return { reason: "invalid" };
  const name = raw.trim();
  if (name.length > lpTickets.LP_TICKET_RECEIPT_NAME_MAX) return { reason: "too_long" };
  return { name: name || null };
}

/** POST の宛名（必須）。不正は 400 receiptName。 */
export function parseReceiptNameInput(body: unknown): string {
  const r = checkReceiptName((body as { receiptName?: unknown } | null)?.receiptName);
  if ("reason" in r) throw errors.validationFailed([{ field: "receiptName", reason: r.reason }]);
  if (!r.name) throw errors.validationFailed([{ field: "receiptName", reason: "required" }]);
  return r.name;
}
