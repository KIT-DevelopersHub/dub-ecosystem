// 当日受付（チェックイン）。権限は policy-table の lp:checkin だけ（ここでは検査しない）。
//
// 受付 = lp_ticket_checkins への INSERT ... ON CONFLICT DO NOTHING の 1 文（変更 0 行 = 受付済み）。
// 同じ券を 2 台で同時に読んでも、片方だけが ok になる。キュー・バッチは使わない。
//
// 開催日と券種の照合: 券種の dayLabel は表示用の自由文字列（例 "Day 1 · 9/13(月)"）。
//   - 空 = 通し券 → どの開催日でも受付できる（日ごとに 1 回）
//   - 日付（M/D・M月D日・YYYY-MM-DD）が読める → 開催日の月日と一致する時だけ受付（違えば wrong_day）
//   - 日付が読めない（"Day 1" だけ等）→ 照合できないので受付は通し、dayCheck = "unverified" で画面に注意を出す
import { errors } from "@dub/errors";
import { jstDay } from "./delivery";
import { orderNumber } from "./ticket-mail";
import { verifyTicketToken } from "./ticket-token";
import type {
  AppDeps,
  CheckinTicketRow,
  LpTicketCheckinDayCheck,
  LpTicketCheckinResponse,
  LpTicketCheckinTicket,
  LpTicketCheckinsPage,
  LpTicketCheckinUndoResponse,
  ReqCtx,
} from "./types";

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TICKET_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
/** 手入力の注文番号（8 文字）と、任意の「-枚目」。 */
const ORDER_REF_RE = /^([A-Za-z0-9]{8})(?:-(\d{1,2}))?$/;
const CODE_MAX = 300;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

export function isEventDay(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = DAY_RE.exec(v);
  if (!m) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** dayLabel に書かれた月日（"M-D"）。読めなければ空。 */
export function labelDates(dayLabel: string): Set<string> {
  const out = new Set<string>();
  const norm = dayLabel.normalize("NFKC");
  for (const m of norm.matchAll(/(\d{4})-(\d{1,2})-(\d{1,2})/g)) out.add(`${Number(m[2])}-${Number(m[3])}`);
  for (const m of norm.matchAll(/(?<![\d-])(\d{1,2})\s*[/月]\s*(\d{1,2})(?!\d)/g)) out.add(`${Number(m[1])}-${Number(m[2])}`);
  return out;
}

/** 券の dayLabel と開催日の照合。false = その日の券ではない。 */
export function dayCheck(dayLabel: string, eventDay: string): LpTicketCheckinDayCheck | false {
  if (dayLabel.trim() === "") return "all_days";
  const dates = labelDates(dayLabel);
  if (dates.size === 0) return "unverified";
  const [, , mm, dd] = DAY_RE.exec(eventDay)!;
  return dates.has(`${Number(mm)}-${Number(dd)}`) ? "match" : false;
}

/** QR の中身（…/t/<token>）・トークン・チケット ID・注文番号(-枚目) を取り出す。 */
export function parseCode(raw: string): { token: string } | { ticketId: string } | { orderRef: string; seat: number | null } | null {
  let code = raw.trim();
  if (code === "" || code.length > CODE_MAX) return null;
  const at = code.lastIndexOf("/t/");
  if (at >= 0) code = code.slice(at + 3).split(/[/?#]/)[0] ?? "";
  if (code.includes(".")) return { token: code };
  const ref = ORDER_REF_RE.exec(code);
  if (ref) return { orderRef: ref[1]!.toUpperCase(), seat: ref[2] ? Number(ref[2]) : null };
  return TICKET_ID_RE.test(code) ? { ticketId: code } : null;
}

const toTicket = (r: CheckinTicketRow): LpTicketCheckinTicket => ({
  ticketId: r.ticket.id,
  orderRef: orderNumber(r.ticket.orderId),
  ticketTypeName: r.ticket.ticketTypeName,
  dayLabel: r.ticket.dayLabel,
  holderName: r.holderName,
  buyerName: r.buyerName,
});

export class CheckinService {
  constructor(private readonly deps: AppDeps) {}

  private eventDayOf(v: unknown): string {
    if (v === undefined || v === null || v === "") return jstDay(this.deps.now());
    if (!isEventDay(v)) throw errors.validationFailed([{ field: "eventDay", reason: "invalid" }]);
    return v;
  }

  private async resolveTicketId(code: unknown): Promise<string | null> {
    if (typeof code !== "string") throw errors.validationFailed([{ field: "code", reason: "required" }]);
    const parsed = parseCode(code);
    if (!parsed) return null;
    if ("token" in parsed) return verifyTicketToken(this.deps.ticketTokenSecret, parsed.token);
    if ("ticketId" in parsed) return parsed.ticketId;
    const ids = await this.deps.repo.ticketIdsByOrderRef(parsed.orderRef);
    if (parsed.seat !== null) return ids[parsed.seat - 1] ?? null;
    // 枚目なしは 1 枚だけの注文に限る（複数枚の注文はどの券か決められない）。
    return ids.length === 1 ? ids[0]! : null;
  }

  async checkin(ctx: ReqCtx, body: unknown): Promise<LpTicketCheckinResponse> {
    const b = (body ?? {}) as { code?: unknown; eventDay?: unknown };
    const eventDay = this.eventDayOf(b.eventDay);
    const none = { checkedInAt: null, checkedInBy: null, dayCheck: null };
    const ticketId = await this.resolveTicketId(b.code);
    const row = ticketId ? await this.deps.repo.getCheckinTicket(ticketId) : null;
    if (!row) return { result: "unknown", eventDay, ticket: null, ...none };
    const ticket = toTicket(row);
    // 返金・取消（void）と、支払い済みでない注文（チャージバック等で要確認）は入れない。
    if (row.ticket.status !== "valid" || row.orderStatus !== "paid") return { result: "void", eventDay, ticket, ...none };
    const check = dayCheck(row.ticket.dayLabel, eventDay);
    if (check === false) return { result: "wrong_day", eventDay, ticket, ...none, dayCheck: null };

    const now = this.deps.now();
    if (await this.deps.repo.insertCheckin({ ticketId: row.ticket.id, eventDay, checkedInAt: now, checkedInBy: ctx.userId })) {
      return { result: "ok", eventDay, ticket, checkedInAt: now, checkedInBy: ctx.userId, dayCheck: check };
    }
    const prior = await this.deps.repo.getCheckin(row.ticket.id, eventDay);
    // 行が無い = INSERT の時点で券が void になっていた（照合と INSERT の間の返金）。
    if (!prior) return { result: "void", eventDay, ticket, ...none };
    return { result: "already", eventDay, ticket, checkedInAt: prior.checkedInAt, checkedInBy: prior.checkedInBy, dayCheck: check };
  }

  async undo(ticketId: string, day: unknown): Promise<LpTicketCheckinUndoResponse> {
    const eventDay = this.eventDayOf(day);
    const removed = await this.deps.repo.deleteCheckin(ticketId, eventDay);
    return { ticketId, eventDay, removed };
  }

  async list(q: { day?: string; cursor?: string; limit?: string }): Promise<LpTicketCheckinsPage> {
    const eventDay = this.eventDayOf(q.day);
    let limit = DEFAULT_PAGE;
    if (q.limit !== undefined) {
      const n = Number(q.limit);
      if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE) throw errors.validationFailed([{ field: "limit", reason: "out_of_range" }]);
      limit = n;
    }
    const [rows, days] = await Promise.all([
      this.deps.repo.listCheckins(eventDay, q.cursor || null, limit + 1),
      this.deps.repo.checkinCounts(),
    ]);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      eventDay,
      count: days.find((d) => d.eventDay === eventDay)?.count ?? 0,
      days,
      items: page.map((r) => ({
        ticketId: r.ticketId,
        eventDay: r.eventDay,
        checkedInAt: r.checkedInAt,
        checkedInBy: r.checkedInBy,
        orderRef: orderNumber(r.orderId),
        ticketTypeName: r.ticketTypeName,
        dayLabel: r.dayLabel,
        holderName: r.holderName,
        buyerName: r.buyerName,
      })),
      nextCursor: rows.length > limit && last ? `${last.checkedInAt}~${last.ticketId}` : null,
    };
  }
}
