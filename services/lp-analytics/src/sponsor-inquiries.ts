// LP スポンサー募集（/sponsors の資料請求）: 設定・受付・一覧と、スポンサーチームへの通知 / 依頼者への受付メール。
// 入力の決まりと HTTP 契約は @dub/types lpSponsor が正本（LP Worker と fe2 も同じものを読む）。
//
// 通知は受付の後に best-effort で送る（届かなくても受付は成功・届いた先は notified_via に残す）:
//  - Dub 通知: app:sponsor:edit を持つ人（ロール管理で決まる）の受信箱へ。notification-service
//    POST /notify（SVC_NOTIFICATION）。push は受信箱の通知に自動で付き、メールは各自の通知設定で on にした人だけ。
//  - メール（任意）: LP管理のスポンサーチームのアドレス、無ければ LP_SPONSOR_NOTIFY_EMAIL（mail-gateway /send）。
//    Dub のアカウントを持たない共有アドレス（sponsor@ など）向け。
// 依頼者への受付メールは入力された文字列を一切入れない（公開フォームを第三者宛ての踏み台にさせない）。
import type { Fetcher } from "@cloudflare/workers-types";
import { errors } from "@dub/errors";
import { createServiceClient } from "@dub/http";
import { lp, lpSponsor, type mail, type notification } from "@dub/types";
import type { ReqCtx } from "./types";

export const SPONSOR_SITE = lp.LP_PUBLISH_SITE;
/** 同じ送信元（IP ハッシュ）から 1 時間に受け付ける件数（無料参加登録 #847 と同じ 10 件 / 時）。 */
export const SPONSOR_PER_CLIENT_MAX = 10;
export const SPONSOR_PER_CLIENT_WINDOW_MS = 60 * 60 * 1000;
export const DEFAULT_DAILY_SPONSOR_CAP = 100;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;
const STATUSES: ReadonlySet<string> = new Set(lpSponsor.LP_SPONSOR_INQUIRY_STATUSES);
const SIGNATURE = "北陸ITカンファレンス スポンサーチーム（DevelopersHub）";

export interface SponsorSettingsRow {
  site: string;
  enabled: boolean;
  notifyEmail: string | null;
  updatedBy: string | null;
  updatedAt: string;
}

export interface SponsorInquiryRow extends lpSponsor.LpSponsorInquiry {
  site: string;
  clientKey: string | null;
}

export interface SponsorInquiryRepo {
  getSponsorSettings(site: string): Promise<SponsorSettingsRow | null>;
  setSponsorEnabled(site: string, enabled: boolean, updatedBy: string, updatedAt: string): Promise<void>;
  setSponsorNotify(site: string, notify: lpSponsor.LpSponsorNotifyInput, updatedBy: string, updatedAt: string): Promise<void>;
  insertSponsorInquiry(row: SponsorInquiryRow): Promise<void>;
  setSponsorInquiryNotified(site: string, id: string, via: lpSponsor.LpSponsorInquiry["notifiedVia"]): Promise<void>;
  getSponsorInquiry(site: string, id: string): Promise<SponsorInquiryRow | null>;
  /** false when the inquiry does not exist. */
  setSponsorInquiryStatus(site: string, id: string, status: lpSponsor.LpSponsorInquiryStatus, updatedBy: string, updatedAt: string): Promise<boolean>;
  /** Newest first, keyset by (created_at, id). */
  listSponsorInquiries(site: string, cursor: string | null, limit: number): Promise<SponsorInquiryRow[]>;
  sponsorInquiryTotals(site: string): Promise<{ total: number; open: number }>;
  /** Inquiries created at/after `since`. With clientKey: only that sender's. */
  countSponsorInquiriesSince(site: string, since: string, clientKey?: string): Promise<number>;
}

/** スポンサーチームへの通知と受付メールの送り口。どれも throw しない（false = 届かなかった）。 */
export interface SponsorNotifier {
  /** Dub 通知（受信箱 + push）。 */
  notifyApp(requestId: string, req: notification.NotifyRequest): Promise<boolean>;
  sendMail(requestId: string, m: { to: string; subject: string; textBody: string }, idempotencyKey: string): Promise<boolean>;
}

export const NOOP_SPONSOR_NOTIFIER: SponsorNotifier = {
  notifyApp: async () => false,
  sendMail: async () => false,
};

export interface SponsorDeps {
  repo: SponsorInquiryRepo;
  lpBaseUrl: string;
  now: () => string;
  newId: () => string;
  notifier: SponsorNotifier;
  /** LP管理で未設定のときのスポンサーチームのメール（env LP_SPONSOR_NOTIFY_EMAIL）。 */
  defaultNotifyEmail: string | null;
  dailyCap: number;
}

// ---- 文面（純粋関数） ----

/** スポンサーチーム向けのメール本文。社内宛てなので入力をそのまま載せる。 */
export function renderTeamNotice(i: lpSponsor.LpSponsorInquiryInput): string {
  return [
    "スポンサーに興味があるという連絡が LP から届きました。",
    "",
    `会社名: ${i.companyName || "（未記入）"}`,
    `担当者名: ${i.contactName || "（未記入）"}`,
    `メールアドレス: ${i.email}`,
    `ひとこと: ${i.message || "（未記入）"}`,
    "",
    "資料の送付と対応状況の記録は Dub の LP管理 > スポンサー募集 から。",
  ].join("\n");
}

/** 依頼者への受付メール。入力された文字列（会社名・氏名・ひとこと）は入れない。 */
export function renderAckMail(email: string): { to: string; subject: string; textBody: string } {
  return {
    to: email,
    subject: "【北陸ITカンファレンス】スポンサー資料のご請求を受け付けました",
    textBody: [
      "北陸ITカンファレンスのスポンサー資料をご請求いただき、ありがとうございます。",
      "",
      "スポンサーチームの担当者より、数日以内にこのメールアドレス宛てに資料をお送りします。",
      "ご不明な点がございましたら、このメールにご返信ください。",
      "",
      "このメールに心当たりがない場合は、お手数ですが破棄してください。",
      "",
      SIGNATURE,
    ].join("\n"),
  };
}

export const SPONSOR_NOTIFY_TITLE = "スポンサーの資料請求が届きました";
const NOTIFY_MESSAGE_HEAD = 200;

/** Dub 通知（受信箱）。本文は 会社名・担当者名・メール・ひとこと（先頭のみ）。 */
export function buildSponsorAppNotify(id: string, i: lpSponsor.LpSponsorInquiryInput): notification.NotifyRequest {
  const message = i.message.length > NOTIFY_MESSAGE_HEAD ? `${i.message.slice(0, NOTIFY_MESSAGE_HEAD)}…` : i.message;
  return {
    type: lpSponsor.LP_SPONSOR_NOTIFY_TYPE,
    recipientIds: [],
    recipientPermissions: [lpSponsor.LP_SPONSOR_NOTIFY_PERMISSION],
    title: SPONSOR_NOTIFY_TITLE,
    body: [
      `会社名: ${i.companyName || "（未記入）"}`,
      `担当者名: ${i.contactName || "（未記入）"}`,
      `メールアドレス: ${i.email}`,
      `ひとこと: ${message || "（未記入）"}`,
    ].join("\n"),
    // in_app（push は自動で付く）+ email（既定 off・各自の通知設定で on にできる）。
    channels: ["in_app", "email"],
    dedupKey: `lp.sponsor_inquiry:${id}`,
    // fe5 がこの組を LP管理 > スポンサー募集（/lp/sponsors）へのリンクにする。
    resourceType: "lp_sponsor_inquiry",
    resourceId: id,
  };
}

export function sponsorCursor(p: { createdAt: string; id: string }): string {
  return `${p.createdAt}~${p.id}`;
}

const toInquiry = ({ site: _s, clientKey: _c, ...p }: SponsorInquiryRow): lpSponsor.LpSponsorInquiry => p;

function jstDayStartIso(iso: string): string {
  const jst = new Date(Date.parse(iso) + 9 * 3600 * 1000).toISOString().slice(0, 10);
  return new Date(`${jst}T00:00:00+09:00`).toISOString();
}

export class SponsorInquiryService {
  constructor(private readonly deps: SponsorDeps) {}

  private get repo() {
    return this.deps.repo;
  }

  async getState(): Promise<lpSponsor.LpSponsorInquiriesState> {
    const [s, totals] = await Promise.all([
      this.repo.getSponsorSettings(SPONSOR_SITE),
      this.repo.sponsorInquiryTotals(SPONSOR_SITE),
    ]);
    return {
      site: SPONSOR_SITE,
      enabled: s?.enabled ?? false,
      publicUrl: `${this.deps.lpBaseUrl.replace(/\/+$/, "")}/sponsors`,
      notifyEmail: s?.notifyEmail ?? null,
      defaultNotifyEmail: this.deps.defaultNotifyEmail,
      totals,
      updatedAt: s?.updatedAt ?? null,
      updatedBy: s?.updatedBy ?? null,
    };
  }

  async setEnabled(ctx: ReqCtx, body: unknown): Promise<lpSponsor.LpSponsorInquiriesState> {
    const enabled = (body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== "boolean") throw errors.validationFailed([{ field: "enabled", reason: "required" }]);
    await this.repo.setSponsorEnabled(SPONSOR_SITE, enabled, ctx.userId, this.deps.now());
    return this.getState();
  }

  async setNotify(ctx: ReqCtx, body: unknown): Promise<lpSponsor.LpSponsorInquiriesState> {
    const { input, issues } = lpSponsor.parseLpSponsorNotify(body);
    if (issues.length > 0) throw errors.validationFailed(issues);
    await this.repo.setSponsorNotify(SPONSOR_SITE, input, ctx.userId, this.deps.now());
    return this.getState();
  }

  async list(q: { cursor?: string; limit?: string }): Promise<lpSponsor.LpSponsorInquiriesPage> {
    const parsed = Number(q.limit ?? DEFAULT_PAGE);
    const limit = Number.isFinite(parsed) ? Math.min(MAX_PAGE, Math.max(1, Math.floor(parsed))) : DEFAULT_PAGE;
    const rows = await this.repo.listSponsorInquiries(SPONSOR_SITE, q.cursor || null, limit + 1);
    const page = rows.slice(0, limit);
    return {
      items: page.map(toInquiry),
      nextCursor: rows.length > limit && page.length > 0 ? sponsorCursor(page[page.length - 1]!) : null,
    };
  }

  async setStatus(ctx: ReqCtx, id: string, body: unknown): Promise<lpSponsor.LpSponsorInquiry> {
    const status = (body as { status?: unknown } | null)?.status;
    if (typeof status !== "string" || !STATUSES.has(status)) {
      throw errors.validationFailed([{ field: "status", reason: "invalid" }]);
    }
    const ok = await this.repo.setSponsorInquiryStatus(
      SPONSOR_SITE,
      id,
      status as lpSponsor.LpSponsorInquiryStatus,
      ctx.userId,
      this.deps.now(),
    );
    if (!ok) throw errors.notFound("lp_sponsor_inquiry", id);
    return toInquiry((await this.repo.getSponsorInquiry(SPONSOR_SITE, id))!);
  }

  // ---- internal (public LP Worker) ----

  async getPublic(): Promise<{ enabled: boolean }> {
    return { enabled: (await this.repo.getSponsorSettings(SPONSOR_SITE))?.enabled ?? false };
  }

  async submit(requestId: string, body: unknown): Promise<{ id: string }> {
    const settings = await this.repo.getSponsorSettings(SPONSOR_SITE);
    if (!settings?.enabled) throw errors.notFound("lp_sponsor_inquiries");
    const { input, issues } = lpSponsor.parseLpSponsorInquiry(body);
    if (issues.length > 0) throw errors.validationFailed(issues);
    const raw = (body as { clientKey?: unknown } | null)?.clientKey;
    const clientKey = typeof raw === "string" && lp.LP_CLIENT_KEY_RE.test(raw) ? raw : null;
    const now = this.deps.now();
    if (
      clientKey &&
      (await this.repo.countSponsorInquiriesSince(
        SPONSOR_SITE,
        new Date(Date.parse(now) - SPONSOR_PER_CLIENT_WINDOW_MS).toISOString(),
        clientKey,
      )) >= SPONSOR_PER_CLIENT_MAX
    ) {
      throw errors.rateLimited(3600);
    }
    if ((await this.repo.countSponsorInquiriesSince(SPONSOR_SITE, jstDayStartIso(now))) >= this.deps.dailyCap) {
      throw errors.rateLimited(600);
    }
    const row: SponsorInquiryRow = {
      id: this.deps.newId(),
      site: SPONSOR_SITE,
      ...input,
      status: "new",
      notifiedVia: "none",
      updatedBy: null,
      clientKey,
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.insertSponsorInquiry(row);

    const notice = renderTeamNotice(input);
    const { notifier } = this.deps;
    const teamEmail = settings.notifyEmail ?? this.deps.defaultNotifyEmail;
    const [app, team] = await Promise.all([
      notifier.notifyApp(requestId, buildSponsorAppNotify(row.id, input)),
      teamEmail
        ? notifier.sendMail(
            requestId,
            { to: teamEmail, subject: `【スポンサー資料請求】${input.companyName || input.email}`.slice(0, 200), textBody: notice },
            `lp-sponsor-team:${row.id}`,
          )
        : Promise.resolve(false),
      notifier.sendMail(requestId, renderAckMail(input.email), `lp-sponsor-ack:${row.id}`),
    ]);
    const via = app && team ? "both" : app ? "app" : team ? "mail" : "none";
    if (via !== "none") await this.repo.setSponsorInquiryNotified(SPONSOR_SITE, row.id, via);
    if (via === "none") console.warn(JSON.stringify({ level: "warn", message: "lp sponsor inquiry not notified", id: row.id }));
    return { id: row.id };
  }
}

/** Service Binding 経由の送り口。mail-gateway /send はユーザー無しのシステム送信として呼ぶ。 */
export function createSponsorNotifier(notificationSvc: Fetcher | undefined, mailGateway: Fetcher | undefined): SponsorNotifier {
  const notifyClient = notificationSvc
    ? createServiceClient(notificationSvc, { service: "notification", caller: "lp-analytics" })
    : null;
  const mailClient = mailGateway ? createServiceClient(mailGateway, { service: "mail-gateway", caller: "lp-analytics" }) : null;
  return {
    async notifyApp(requestId, req) {
      if (!notifyClient) return false;
      try {
        await notifyClient.post<{ notificationId: string; deduplicated: boolean }, notification.NotifyRequest>(
          { requestId },
          "/notify",
          req,
          { timeoutMs: 12_000, retry: false },
        );
        return true;
      } catch {
        return false;
      }
    },
    async sendMail(requestId, m, idempotencyKey) {
      if (!mailClient) return false;
      try {
        await mailClient.post<mail.SendMailResponse, mail.SendMailRequest>(
          { requestId },
          "/send",
          { to: [{ email: m.to }], subject: m.subject, textBody: m.textBody },
          { idempotencyKey, timeoutMs: 12_000, retry: false },
        );
        return true;
      } catch {
        return false;
      }
    },
  };
}

