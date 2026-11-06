// 購入後の受け渡し: チケット発行 → outbox → 送信、と毎日のバックアップ。
//
// 支払い済みになる経路（settle / 無料クーポン / approve / チャージバック勝訴）はすべて fulfill() に集まる。
// fulfill と送信は決済の経路を決して失敗させない。落ちた分は reconcile の見直し（sweep）と drain が拾う。
//
// 1 回の Worker 実行で使える subrequest には上限があるので、drain は 1 文で複数行を確保し、
// 結果も 1 バッチで書く。送信済みの記録が失われてもリース切れの再送は Idempotency-Key で止まる。
import { consoleSink, type LogLevel } from "@dub/observability";
import { lp } from "@dub/types";
import { ordersCsv } from "./ticket-csv";
import { EVENT_NAME, isTestOrder, orderNumber, renderBuyerMail, renderOpsMail, type RenderedMail, type TicketPass } from "./ticket-mail";
import { ticketToken, verifyTicketToken } from "./ticket-token";
import type { OutboundMail } from "./mailer";
import type { AppDeps, OutboxKind, OutboxRow, OutboxUpdate, TicketOrderRow, TicketRow } from "./types";

const SITE = lp.LP_PUBLISH_SITE;

/** Refusals by Resend before a row ends in 'failed' (about 4 hours with the backoff below). */
export const OUTBOX_MAX_ATTEMPTS = 10;
export const OUTBOX_BACKOFF_BASE_MS = 60 * 1000;
export const OUTBOX_BACKOFF_CAP_MS = 60 * 60 * 1000;
/** Resend down or our key broken: not the row's fault, so it is retried without counting. */
export const OUTBOX_TRANSIENT_RETRY_MS = 5 * 60 * 1000;
export const OUTBOX_RATE_LIMIT_RETRY_MS = 60 * 1000;
/** Order under review (dispute): the mail waits, unsent and uncounted. */
export const OUTBOX_HOLD_MS = 60 * 60 * 1000;
/** Longer than a full drain, so a live drain never loses its rows. */
export const OUTBOX_LEASE_MS = 2 * 60 * 1000;

/** Resend's default limit is about 2 requests per second. */
export const MAIL_MIN_INTERVAL_MS = 550;
export const DRAIN_BUDGET_MS = 25 * 1000;
export const DRAIN_BATCH_MAX = 30;
/** Rows due this soon count as backlog: the alarm comes back in a minute instead of ten. */
export const BACKLOG_WINDOW_MS = 3 * 60 * 1000;
/** Free plan: subrequests one reconcile pass may spend. Stripe, D1 and Resend all count. */
export const PASS_SUBREQUEST_BUDGET = 45;
const DRAIN_OVERHEAD_SUBREQUESTS = 6;
const DAILY_SUBREQUESTS = 30;

export const SWEEP_LIMIT = 10;
/** Every pass looks this far back; the full table is read once per JST day (it costs D1 rows). */
export const SWEEP_RECENT_MS = 60 * 60 * 1000;

const EXPORT_PAGE = 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const JOB_BACKUP_DAY = "backup_day";
const JOB_SWEEP_DAY = "full_sweep_day";
const JOB_CSV_SHA = "daily_csv_sha";

export interface DrainResult {
  sent: number;
  /** Still pending after this drain. */
  retried: number;
  failed: number;
}

export interface DeliverySummary {
  fulfilled: number;
  mailSent: number;
  mailRetried: number;
  mailFailed: number;
  /** Rows due now or within BACKLOG_WINDOW_MS: the DO alarm comes back soon. */
  mailBacklog: number;
}

export interface PublicPass {
  event: string;
  ticketTypeName: string;
  dayLabel: string;
  status: "valid" | "void";
  orderRef: string;
}

function log(level: LogLevel, message: string, fields: Record<string, unknown>): void {
  consoleSink({ level, message, service: "lp-tickets", fields });
}

export const jstDay = (iso: string): string => new Date(Date.parse(iso) + JST_OFFSET_MS).toISOString().slice(0, 10);

/** One ticket per seat and the mails the order owes. Ids are derived, so re-running yields the same rows. */
export function fulfilmentOf(order: TicketOrderRow, now: string): { tickets: TicketRow[]; outbox: OutboxRow[] } {
  const seats = order.items.flatMap((i) => Array.from({ length: i.quantity }, () => i));
  const tickets = seats.map(
    (i, n): TicketRow => ({
      id: `${order.id}-${n + 1}`,
      orderId: order.id,
      ticketTypeId: i.ticketTypeId,
      ticketTypeName: i.ticketTypeName,
      dayLabel: i.dayLabel,
      status: "valid",
      createdAt: now,
      voidedAt: null,
    }),
  );
  const kinds: OutboxKind[] = isTestOrder(order) ? ["buyer_confirmation"] : ["buyer_confirmation", "ops_copy"];
  const outbox = kinds.map(
    (kind): OutboxRow => ({
      id: `${order.id}:${kind}`,
      orderId: order.id,
      kind,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      lastError: null,
      sentAt: null,
      createdAt: now,
    }),
  );
  return { tickets, outbox };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export class TicketDelivery {
  constructor(private readonly deps: AppDeps) {}

  private get repo() {
    return this.deps.repo;
  }

  private plusMs(ms: number): string {
    return new Date(Date.parse(this.deps.now()) + ms).toISOString();
  }

  /** Tickets + outbox for a paid order. Idempotent, and never fails the payment path. */
  async fulfill(orderId: string): Promise<void> {
    try {
      const order = await this.repo.getOrder(SITE, orderId);
      if (!order || order.status !== "paid") return;
      const { tickets, outbox } = fulfilmentOf(order, this.deps.now());
      await this.repo.issueFulfilment(order.id, tickets, outbox);
    } catch (e) {
      log("error", "lp ticket fulfil failed", { orderId, error: String(e) });
    }
  }

  /** Every route that makes an order paid ends here. */
  async onPaid(orderId: string): Promise<void> {
    await this.fulfill(orderId);
    this.sendSoon(orderId);
  }

  /** The buyer's mail right after payment. In a burst Resend answers 429 and the alarm takes over. */
  private sendSoon(orderId: string): void {
    const { defer, armReconcile } = this.deps;
    if (!defer || this.deliverableKinds().length === 0) return;
    defer(
      this.drain({ orderId, limit: 2, budgetMs: DRAIN_BUDGET_MS })
        .then((r) => (r.retried > 0 ? armReconcile?.({ soon: true }) : undefined))
        .catch((e) => log("error", "lp ticket immediate send failed", { orderId, error: String(e) })),
    );
  }

  private deliverableKinds(): OutboxKind[] {
    if (!this.deps.mailer) return [];
    return [
      ...(this.deps.ticketTokenSecret ? (["buyer_confirmation"] as const) : []),
      ...(this.deps.ticketOpsEmail ? (["ops_copy"] as const) : []),
    ];
  }

  private async passes(tickets: readonly TicketRow[]): Promise<TicketPass[]> {
    const base = this.deps.lpBaseUrl.replace(/\/+$/, "");
    const secret = this.deps.ticketTokenSecret!;
    return Promise.all(
      tickets.map(async (ticket) => {
        const url = `${base}/t/${await ticketToken(secret, ticket.id)}`;
        return { ticket, url, qrUrl: `${url}/qr.png` };
      }),
    );
  }

  private async mailFor(row: OutboxRow, order: TicketOrderRow, tickets: readonly TicketRow[]): Promise<OutboundMail | null> {
    let rendered: RenderedMail;
    let to: string;
    if (row.kind === "buyer_confirmation") {
      const valid = tickets.filter((t) => t.status === "valid");
      if (valid.length === 0) return null;
      rendered = renderBuyerMail(order, await this.passes(valid));
      to = order.buyerEmail;
    } else {
      rendered = renderOpsMail(order);
      to = this.deps.ticketOpsEmail!;
    }
    return { from: this.deps.ticketMailFrom, to, ...rendered };
  }

  private counted(row: OutboxRow, error: string): OutboxUpdate {
    const attempts = row.attempts + 1;
    if (attempts >= OUTBOX_MAX_ATTEMPTS) {
      log("error", "lp ticket mail gave up", { orderId: row.orderId, kind: row.kind, attempts, error });
      return { id: row.id, status: "failed", attempts, nextAttemptAt: row.nextAttemptAt, lastError: error, sentAt: null };
    }
    const delay = Math.min(OUTBOX_BACKOFF_CAP_MS, OUTBOX_BACKOFF_BASE_MS * 2 ** (attempts - 1));
    return { id: row.id, status: "pending", attempts, nextAttemptAt: this.plusMs(delay), lastError: error, sentAt: null };
  }

  private later(row: OutboxRow, delayMs: number, error: string): OutboxUpdate {
    return { id: row.id, status: "pending", attempts: row.attempts, nextAttemptAt: this.plusMs(delayMs), lastError: error, sentAt: null };
  }

  /** One row. `stop` = Resend is not taking mail, so the rest of the batch goes back unsent. */
  private async sendRow(
    row: OutboxRow,
    order: TicketOrderRow | undefined,
    tickets: readonly TicketRow[],
  ): Promise<{ update: OutboxUpdate; stop?: boolean }> {
    if (!order) return { update: this.counted(row, "order_missing") };
    if (order.status === "refunded") {
      return {
        update: { id: row.id, status: "failed", attempts: row.attempts, nextAttemptAt: row.nextAttemptAt, lastError: "order_refunded", sentAt: null },
      };
    }
    if (order.status !== "paid") return { update: this.later(row, OUTBOX_HOLD_MS, "order_on_hold") };
    let mail: OutboundMail | null;
    try {
      mail = await this.mailFor(row, order, tickets);
    } catch {
      return { update: this.counted(row, "render_failed") };
    }
    if (!mail) return { update: this.counted(row, "no_valid_tickets") };
    let res;
    try {
      res = await this.deps.mailer!.send(mail, row.id);
    } catch {
      res = { ok: false as const, failure: "transient" as const, error: "send_threw" };
    }
    if (res.ok) {
      const now = this.deps.now();
      return { update: { id: row.id, status: "sent", attempts: row.attempts, nextAttemptAt: now, lastError: null, sentAt: now } };
    }
    log(res.failure === "rejected" ? "warn" : "error", "lp ticket mail not sent", {
      orderId: row.orderId,
      kind: row.kind,
      failure: res.failure,
      error: res.error,
    });
    if (res.failure === "rejected") return { update: this.counted(row, res.error) };
    const delay =
      res.failure === "rate_limited"
        ? Math.max(OUTBOX_RATE_LIMIT_RETRY_MS, (res.retryAfterSec ?? 0) * 1000)
        : OUTBOX_TRANSIENT_RETRY_MS;
    return { update: this.later(row, delay, res.error), stop: true };
  }

  /** Mails left today under TICKET_MAIL_DAILY_CAP. Over the cap rows just wait: attempts are not counted. */
  private async dailyAllowance(now: string): Promise<number> {
    const cap = this.deps.ticketMailDailyCap;
    if (cap === null) return DRAIN_BATCH_MAX;
    const dayStart = Math.floor((Date.parse(now) + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS;
    return Math.max(0, cap - (await this.repo.countOutboxSentSince(new Date(dayStart).toISOString())));
  }

  /** Sends due rows, paced. Two drains at once split the rows between them: the claim hands each to one. */
  async drain(o: { orderId?: string; limit?: number; budgetMs?: number } = {}): Promise<DrainResult> {
    const result: DrainResult = { sent: 0, retried: 0, failed: 0 };
    const kinds = this.deliverableKinds();
    if (kinds.length === 0) return result;
    const now = this.deps.now();
    const deadline = Date.parse(now) + (o.budgetMs ?? DRAIN_BUDGET_MS);
    const allowance = await this.dailyAllowance(now);
    if (allowance === 0) return result;
    const claimed = await this.repo.claimOutbox({
      now,
      leaseUntil: this.plusMs(OUTBOX_LEASE_MS),
      kinds,
      limit: Math.min(o.limit ?? DRAIN_BATCH_MAX, DRAIN_BATCH_MAX, allowance),
      ...(o.orderId ? { orderId: o.orderId } : {}),
    });
    if (claimed.length === 0) return result;
    const orderIds = [...new Set(claimed.map((r) => r.orderId))];
    const [orders, tickets] = await Promise.all([this.repo.ordersByIds(SITE, orderIds), this.repo.ticketsForOrders(orderIds)]);
    const orderById = new Map(orders.map((x) => [x.id, x]));

    const updates: OutboxUpdate[] = [];
    let stopped = false;
    let sends = 0;
    try {
      for (const row of claimed) {
        if (!stopped && sends++ > 0) await this.deps.sleep(MAIL_MIN_INTERVAL_MS);
        if (stopped || Date.parse(this.deps.now()) >= deadline) {
          stopped = true;
          updates.push({ ...row, nextAttemptAt: this.deps.now() });
          continue;
        }
        const { update, stop } = await this.sendRow(
          row,
          orderById.get(row.orderId),
          tickets.filter((t) => t.orderId === row.orderId),
        );
        updates.push(update);
        stopped = stop === true;
      }
    } finally {
      await this.repo.applyOutboxUpdates(updates);
    }
    for (const u of updates) {
      if (u.status === "sent") result.sent++;
      else if (u.status === "failed") result.failed++;
      else result.retried++;
    }
    return result;
  }

  /** A drain plus the backlog check the alarm schedules on. Errors stay here. */
  async drainPass(limit = DRAIN_BATCH_MAX): Promise<Omit<DeliverySummary, "fulfilled">> {
    const sum = { mailSent: 0, mailRetried: 0, mailFailed: 0, mailBacklog: 0 };
    try {
      if (limit > 0) {
        const r = await this.drain({ limit });
        sum.mailSent = r.sent;
        sum.mailRetried = r.retried;
        sum.mailFailed = r.failed;
      }
      const due = await this.repo.outboxDue(this.plusMs(BACKLOG_WINDOW_MS));
      const buyers = due.get("buyer_confirmation") ?? 0;
      const ops = due.get("ops_copy") ?? 0;
      if (!this.deps.mailer && buyers + ops > 0) log("error", "lp ticket mail pending: RESEND_API_KEY is not set", { buyers, ops });
      if (!this.deps.ticketTokenSecret && buyers > 0) log("error", "lp ticket mail pending: TICKET_TOKEN_SECRET is not set", { buyers });
      if (!this.deps.ticketOpsEmail && ops > 0) log("error", "lp ticket ops copy pending: TICKET_OPS_EMAIL is not set", { ops });
      sum.mailBacklog = this.deliverableKinds().reduce((n, k) => n + (due.get(k) ?? 0), 0);
    } catch (e) {
      log("error", "lp ticket drain failed", { error: String(e) });
    }
    return sum;
  }

  /** Paid orders that crashed before fulfil, plus (first run of each JST day) anything older. */
  private async sweep(jobs: ReadonlyMap<string, string>): Promise<number> {
    const now = this.deps.now();
    const day = jstDay(now);
    const full = jobs.get(JOB_SWEEP_DAY) !== day;
    const rows = await this.repo.listUnfulfilled(SITE, full ? null : this.plusMs(-SWEEP_RECENT_MS), SWEEP_LIMIT);
    for (const order of rows) {
      log("warn", "lp ticket paid order fulfilled by sweep", { orderId: order.id });
      await this.fulfill(order.id);
    }
    if (full && rows.length < SWEEP_LIMIT) await this.repo.setJobState(JOB_SWEEP_DAY, day, now);
    return rows.length;
  }

  async allOrders(): Promise<TicketOrderRow[]> {
    const out: TicketOrderRow[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: TicketOrderRow[] = await this.repo.listOrdersAscending(SITE, cursor, EXPORT_PAGE);
      out.push(...page);
      if (page.length < EXPORT_PAGE) return out;
      const last = page[page.length - 1]!;
      cursor = `${last.createdAt}~${last.id}`;
    }
  }

  private async allTickets(): Promise<TicketRow[]> {
    const out: TicketRow[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: TicketRow[] = await this.repo.listTickets(cursor, EXPORT_PAGE);
      out.push(...page);
      if (page.length < EXPORT_PAGE) return out;
      cursor = page[page.length - 1]!.id;
    }
  }

  /** Everything needed to rebuild the sale. Tokens are derived, never stored, so none can end up here. */
  private async snapshot(exportedAt: string) {
    const [settings, types, coupons, orders, tickets] = await Promise.all([
      this.repo.getTicketSettings(SITE),
      this.repo.listTicketTypes(SITE),
      this.repo.listCoupons(SITE),
      this.allOrders(),
      this.allTickets(),
    ]);
    return { exportedAt, site: SITE, settings, types, coupons, orders, tickets };
  }

  /** Once per JST day. true = it ran (the pass has fewer subrequests left for mail). */
  private async daily(jobs: ReadonlyMap<string, string>): Promise<boolean> {
    const { backup, mailer, ticketOpsEmail: ops } = this.deps;
    if (!backup && !(mailer && ops)) return false;
    const now = this.deps.now();
    const day = jstDay(now);
    if (jobs.get(JOB_BACKUP_DAY) === day) return false;
    const snap = await this.snapshot(now);
    if (backup) {
      const key = `tickets/${day}.json`;
      if (!(await backup.exists(key))) await backup.put(key, JSON.stringify(snap));
    }
    await this.repo.setJobState(JOB_BACKUP_DAY, day, now);
    if (!mailer || !ops || snap.orders.length === 0) return true;

    const csv = ordersCsv(snap.orders, snap.settings?.fields ?? []);
    const sha = await sha256Hex(csv);
    if (sha === jobs.get(JOB_CSV_SHA)) return true;
    const res = await mailer.send(
      {
        from: this.deps.ticketMailFrom,
        to: ops,
        subject: `[LP チケット] 購入者一覧 ${day}`,
        text: `${day} 時点の購入者一覧です（${snap.orders.length} 件）。`,
        attachments: [{ filename: `lp-ticket-orders-${day}.csv`, contentBase64: base64Utf8(csv), contentType: "text/csv" }],
      },
      `daily-${day}-${sha.slice(0, 16)}`,
    );
    if (res.ok) await this.repo.setJobState(JOB_CSV_SHA, sha, now);
    else log("error", "lp ticket daily csv not sent", { day, failure: res.failure, error: res.error });
    return true;
  }

  /** The delivery half of reconcile. `spent` = subrequests the Stripe half already used. */
  async reconcilePass(spent: number): Promise<DeliverySummary> {
    let left = PASS_SUBREQUEST_BUDGET - spent;
    let fulfilled = 0;
    let jobs = new Map<string, string>();
    try {
      jobs = await this.repo.getJobStates();
      left -= 1;
      fulfilled = await this.sweep(jobs);
      left -= 3 + fulfilled * 3;
    } catch (e) {
      log("error", "lp ticket sweep failed", { error: String(e) });
    }
    try {
      if (await this.daily(jobs)) left -= DAILY_SUBREQUESTS;
    } catch (e) {
      log("error", "lp ticket daily backup failed", { error: String(e) });
    }
    return { fulfilled, ...(await this.drainPass(Math.max(0, left - DRAIN_OVERHEAD_SUBREQUESTS))) };
  }

  /** LP Worker: what a ticket URL shows. No buyer data. null for anything but a genuine token. */
  async pass(token: string): Promise<PublicPass | null> {
    const id = await verifyTicketToken(this.deps.ticketTokenSecret, token);
    const ticket = id ? await this.repo.getTicket(id) : null;
    if (!ticket) return null;
    return {
      event: EVENT_NAME,
      ticketTypeName: ticket.ticketTypeName,
      dayLabel: ticket.dayLabel,
      status: ticket.status,
      orderRef: orderNumber(ticket.orderId),
    };
  }
}
