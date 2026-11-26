// LP管理 → 受付 の view-model（純粋関数）。画面とフックはここだけを見て表示・楽観更新を決める。
import type { LpTicketCheckin, LpTicketCheckinResponse, LpTicketCheckinsPage, LpTicketCheckinTicket } from "./lpApi.tsx";

export type CheckinTone = "ok" | "warn" | "error";

export interface CheckinView {
  tone: CheckinTone;
  /** 大きく出す 1 行。 */
  title: string;
  /** 補足（受付済みの時刻・券の日付など）。 */
  detail: string | null;
  /** 名札の名前（参加者名 → 購入者名）。券が無い時 null。 */
  name: string | null;
  /** 券種（+ 日付）。 */
  ticketLabel: string | null;
  /** 受付を取り消せるか（今回 ok にした券だけ）。 */
  canUndo: boolean;
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** 'YYYY-MM-DD' → '12/12(土)'。 */
export function formatEventDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEKDAYS[d.getUTCDay()]})`;
}

/** ISO → 日本時間の 'HH:MM'。 */
export function formatTimeJst(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

export const attendeeName = (t: Pick<LpTicketCheckinTicket, "holderName" | "buyerName">): string =>
  t.holderName?.trim() || t.buyerName.trim() || "（名前なし）";

export const ticketLabel = (t: Pick<LpTicketCheckinTicket, "ticketTypeName" | "dayLabel">): string =>
  t.dayLabel ? `${t.ticketTypeName}（${t.dayLabel}）` : t.ticketTypeName;

export function checkinView(res: LpTicketCheckinResponse): CheckinView {
  const t = res.ticket;
  const base = { name: t ? attendeeName(t) : null, ticketLabel: t ? ticketLabel(t) : null, canUndo: false };
  switch (res.result) {
    case "ok":
      return {
        ...base,
        tone: res.dayCheck === "unverified" ? "warn" : "ok",
        title: "受付しました",
        detail: res.dayCheck === "unverified" ? `券の日付を確認してください（${t?.dayLabel ?? ""}）` : null,
        canUndo: true,
      };
    case "already":
      return {
        ...base,
        tone: "warn",
        title: "受付済みです",
        detail: res.checkedInAt ? `${formatTimeJst(res.checkedInAt)} に受付済み` : "この日はもう受付されています",
      };
    case "void":
      return { ...base, tone: "error", title: "無効なチケットです", detail: "返金・取消済み、または支払いが確定していません" };
    case "wrong_day":
      return {
        ...base,
        tone: "error",
        title: "この日のチケットではありません",
        // 券の日付は ticketLabel に出ているので、ここでは受付日の方を示して見比べられるようにする。
        detail: `受付日は ${formatEventDay(res.eventDay)} です`,
      };
    case "unknown":
    default:
      return {
        ...base,
        tone: "error",
        title: "チケットが見つかりません",
        detail: "QR をもう一度読むか、注文番号（例 ABCD1234-1）を入力してください",
      };
  }
}

/** カメラは同じ QR を毎フレーム読むので、同じコードは windowMs の間 1 回だけ通す。 */
export function shouldAcceptScan(
  code: string,
  last: { code: string; at: number } | null,
  now: number,
  windowMs = 4000,
): boolean {
  const c = code.trim();
  if (!c) return false;
  return !(last && last.code === c && now - last.at < windowMs);
}

/** 手入力欄の整形（前後空白・全角英数を半角に）。空なら null。 */
export function normalizeManualCode(raw: string): string | null {
  const s = raw.normalize("NFKC").trim();
  return s ? s : null;
}

/** 受付ボタンを押した直後（結果待ち）の楽観表示: 件数だけ +1。 */
export function withPendingCheckin(page: LpTicketCheckinsPage): LpTicketCheckinsPage {
  return { ...page, count: page.count + 1, days: bumpDay(page.days, page.eventDay, 1) };
}

/** サーバーが ok を返した券を一覧の先頭に入れる（件数は withPendingCheckin で足し済み）。 */
export function withCheckinRow(page: LpTicketCheckinsPage, res: LpTicketCheckinResponse): LpTicketCheckinsPage {
  if (res.result !== "ok" || !res.ticket || !res.checkedInAt) return page;
  const row: LpTicketCheckin = {
    ticketId: res.ticket.ticketId,
    eventDay: res.eventDay,
    checkedInAt: res.checkedInAt,
    checkedInBy: res.checkedInBy ?? "",
    orderRef: res.ticket.orderRef,
    ticketTypeName: res.ticket.ticketTypeName,
    dayLabel: res.ticket.dayLabel,
    holderName: res.ticket.holderName,
    buyerName: res.ticket.buyerName,
  };
  return { ...page, items: [row, ...page.items.filter((i) => i.ticketId !== row.ticketId)] };
}

/** 取り消しの楽観表示: 一覧から外して件数 -1。 */
export function withoutCheckin(page: LpTicketCheckinsPage, ticketId: string): LpTicketCheckinsPage {
  if (!page.items.some((i) => i.ticketId === ticketId)) return page;
  return {
    ...page,
    count: Math.max(0, page.count - 1),
    days: bumpDay(page.days, page.eventDay, -1),
    items: page.items.filter((i) => i.ticketId !== ticketId),
  };
}

function bumpDay(days: LpTicketCheckinsPage["days"], eventDay: string, delta: number): LpTicketCheckinsPage["days"] {
  const has = days.some((d) => d.eventDay === eventDay);
  const next = has ? days.map((d) => (d.eventDay === eventDay ? { ...d, count: Math.max(0, d.count + delta) } : d)) : [...days, { eventDay, count: Math.max(0, delta) }];
  return next.filter((d) => d.count > 0).sort((a, b) => (a.eventDay < b.eventDay ? -1 : 1));
}
