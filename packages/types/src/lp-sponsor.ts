// lpSponsor — LP スポンサー募集（/sponsors の資料請求）の HTTP 契約と入力の検証。
// lp-analytics が返し、fe2（LP管理 > スポンサー募集）と公開 LP Worker が読む。どちらもここから import し、
// ローカルに再宣言しない。LP Worker が node --test（strip-only TS）で直接読むので、実行時の import は持たない。

export const LP_SPONSOR_COMPANY_MAX = 100;
export const LP_SPONSOR_NAME_MAX = 100;
export const LP_SPONSOR_EMAIL_MAX = 254;
export const LP_SPONSOR_MESSAGE_MAX = 1000;
/** Dub チャットのチャンネル id（chat-service の newId("chn")）。 */
export const LP_SPONSOR_CHANNEL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** new = 未対応 / sent = 資料送付済み / closed = 対応終了。 */
export type LpSponsorInquiryStatus = "new" | "sent" | "closed";
export const LP_SPONSOR_INQUIRY_STATUSES: readonly LpSponsorInquiryStatus[] = ["new", "sent", "closed"];

/** GET /lp/sponsor-inquiries（LP管理）。 */
export interface LpSponsorInquiriesState {
  site: string;
  /** スポンサー募集の公開（LP の JOIN スポンサーカード → /sponsors）。 */
  enabled: boolean;
  /** LP_BASE_URL + "/sponsors" */
  publicUrl: string;
  /** 通知を流す Dub チャットのチャンネル id。null = チャットには流さない。 */
  notifyChannelId: string | null;
  /** 通知を送るスポンサーチームのメール。null = 環境の既定（LP_SPONSOR_NOTIFY_EMAIL）を使う。 */
  notifyEmail: string | null;
  /** notifyEmail が null のときに使われる環境の既定（未設定なら null）。 */
  defaultNotifyEmail: string | null;
  totals: { total: number; open: number };
  updatedAt: string | null;
  updatedBy: string | null;
}

/** POST /lp/sponsor-inquiries/notify（LP管理）。空文字 / null = 解除。 */
export interface LpSponsorNotifyInput {
  notifyChannelId: string | null;
  notifyEmail: string | null;
}

export interface LpSponsorInquiry {
  id: string;
  companyName: string;
  contactName: string;
  email: string;
  message: string;
  status: LpSponsorInquiryStatus;
  /** スポンサーチームへの通知: chat / mail / both / none（どこにも届かなかった）。 */
  notifiedVia: "chat" | "mail" | "both" | "none";
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LpSponsorInquiriesPage {
  items: LpSponsorInquiry[];
  nextCursor: string | null;
}

/** 公開フォームの入力（LP Worker → lp-analytics の内部 API。clientKey は Worker が付ける）。 */
export interface LpSponsorInquiryInput {
  companyName: string;
  contactName: string;
  email: string;
  message: string;
}

export interface LpSponsorIssue {
  field: keyof LpSponsorInquiryInput;
  reason: "required" | "too_long" | "invalid";
}

/** 必須はメールだけ。LP Worker（画面の表示）と lp-analytics（400）で同じ決まりを使う。 */
export function parseLpSponsorInquiry(body: unknown): { input: LpSponsorInquiryInput; issues: LpSponsorIssue[] } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const issues: LpSponsorIssue[] = [];
  const text = (k: keyof LpSponsorInquiryInput, max: number, required: boolean): string => {
    const v = typeof b[k] === "string" ? (b[k] as string).trim() : "";
    if (!v && required) issues.push({ field: k, reason: "required" });
    else if (v.length > max) issues.push({ field: k, reason: "too_long" });
    return v;
  };
  const companyName = text("companyName", LP_SPONSOR_COMPANY_MAX, false);
  const contactName = text("contactName", LP_SPONSOR_NAME_MAX, false);
  const email = text("email", LP_SPONSOR_EMAIL_MAX, true);
  if (email && email.length <= LP_SPONSOR_EMAIL_MAX && !EMAIL_RE.test(email)) issues.push({ field: "email", reason: "invalid" });
  const message = text("message", LP_SPONSOR_MESSAGE_MAX, false);
  return { input: { companyName, contactName, email, message }, issues };
}

/** LP管理の通知先の検証。空文字は null（解除）。 */
export function parseLpSponsorNotify(body: unknown): { input: LpSponsorNotifyInput; issues: { field: keyof LpSponsorNotifyInput; reason: "invalid" }[] } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const issues: { field: keyof LpSponsorNotifyInput; reason: "invalid" }[] = [];
  const opt = (k: keyof LpSponsorNotifyInput, ok: (v: string) => boolean): string | null => {
    const raw = b[k];
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== "string") {
      issues.push({ field: k, reason: "invalid" });
      return null;
    }
    const v = raw.trim();
    if (!v) return null;
    if (!ok(v)) issues.push({ field: k, reason: "invalid" });
    return v;
  };
  const notifyChannelId = opt("notifyChannelId", (v) => LP_SPONSOR_CHANNEL_ID_RE.test(v));
  const notifyEmail = opt("notifyEmail", (v) => v.length <= LP_SPONSOR_EMAIL_MAX && EMAIL_RE.test(v));
  return { input: { notifyChannelId, notifyEmail }, issues };
}
