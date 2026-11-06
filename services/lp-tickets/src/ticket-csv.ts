// 購入者の CSV（LP管理の書き出しと毎日のメールで同じもの）。1 注文 1 行・回答は項目名ごとの列。
// Excel で開く前提なので UTF-8 BOM を付け、数式として解釈される値は先頭に ' を付けて無害化する。
import { isTestOrder, orderNumber } from "./ticket-mail";
import type { LpTicketField, TicketOrderRow } from "./types";

const BOM = "﻿";
// 全角の記号も Excel は式として受け取ることがある。前に空白があっても同じ。
const FORMULA_LEAD = /^[\s]*[=+\-@＝＋－＠]|^[\t\r]/;

export function csvCell(value: string | number | null): string {
  let s = value === null ? "" : String(value);
  if (typeof value === "string" && FORMULA_LEAD.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const row = (cells: readonly (string | number | null)[]): string => cells.map(csvCell).join(",");

/** Configured labels first, then labels only old orders still carry. */
function answerLabels(orders: readonly TicketOrderRow[], fields: readonly LpTicketField[]): string[] {
  const labels = new Set(fields.map((f) => f.label));
  for (const o of orders) for (const a of o.answers) labels.add(a.label);
  return [...labels];
}

export function ordersCsv(orders: readonly TicketOrderRow[], fields: readonly LpTicketField[]): string {
  const labels = answerLabels(orders, fields);
  const head = [
    "注文番号",
    "注文ID",
    "状態",
    "テスト",
    "氏名",
    "メール",
    "明細",
    "枚数",
    "金額",
    "決済手段",
    "クーポンID",
    "作成日時",
    "支払日時",
    "返金日時",
    ...labels,
  ];
  const body = orders.map((o) => {
    const answers = new Map(o.answers.map((a) => [a.label, a.value]));
    return row([
      orderNumber(o.id),
      o.id,
      o.status,
      isTestOrder(o) ? "テスト" : "",
      o.buyerName,
      o.buyerEmail,
      o.items.map((i) => `${i.ticketTypeName}${i.dayLabel ? ` ${i.dayLabel}` : ""} x${i.quantity}`).join(" / "),
      o.quantity,
      o.amountJpy,
      o.paymentMethod,
      o.couponId,
      o.createdAt,
      o.paidAt,
      o.refundedAt,
      ...labels.map((l) => answers.get(l) ?? null),
    ]);
  });
  return `${BOM}${[row(head), ...body].join("\r\n")}\r\n`;
}
