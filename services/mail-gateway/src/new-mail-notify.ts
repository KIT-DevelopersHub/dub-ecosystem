// 新着メールの通知 (#869): 受信箱に届いたメールを、その持ち主に Dub の通知 (受信箱 + push) で知らせる。
// notification-service POST /notify (SVC_NOTIFICATION)。lp-analytics のスポンサー通知と同じ形。
//
// - 1 通の配送 (持ち主ごと) につき 1 件。dedupKey = 受信行 id + 持ち主なので、再配送は通知側で重複しない。
// - 知らせないもの: 持ち主のいない配送 (archive@ / チームの宛先)、ブロック済みの送信者 (呼び出し側で判定)、
//   自動送信 (Auto-Submitted / ループ印)、一斉配信 (Precedence: bulk / list / junk)。
// - best-effort: 失敗してもメールの受信は失敗させない (ログだけ)。
// - ON/OFF は各自の通知設定 (mail.received の in_app / push)。ここでは見ない (通知側が判定する)。
import type { Fetcher } from "@cloudflare/workers-types";
import { createServiceClient, type RequestContext } from "@dub/http";
import { consoleSink } from "@dub/observability";
import { mail, type notification } from "@dub/types";
import { SERVICE_NAME } from "./config";
import { isAutoReply } from "./sponsor-sync";

export interface NewMailNotifyPort {
  notify(ctx: RequestContext, req: notification.NotifyRequest): Promise<void>;
}

/** POST なので再試行しない (subrequest 1 つ)。 */
export function newMailNotifyVia(svc: Fetcher): NewMailNotifyPort {
  const client = createServiceClient(svc, { service: "notification", caller: SERVICE_NAME, timeoutMs: 5_000 });
  return {
    async notify(ctx, req) {
      await client.post(ctx, "/notify", req, { retry: false });
    },
  };
}

/** MAIL_NEW_MAIL_NOTIFY="off" で止められる (既定は on)。 */
export function newMailNotifyDisabled(flag: string | undefined): boolean {
  return flag?.trim().toLowerCase() === "off";
}

const BULK_PRECEDENCE: ReadonlySet<string> = new Set(["bulk", "list", "junk"]);

/** 自動送信・一斉配信は通知しない (人が送ったメールだけ)。 */
export function isAutomatedMail(headers: Readonly<Record<string, string | undefined>>): boolean {
  if (isAutoReply(headers["auto-submitted"], headers["x-dub-mail-loop"])) return true;
  const precedence = headers["precedence"]?.trim().toLowerCase();
  return Boolean(precedence && BULK_PRECEDENCE.has(precedence));
}

const TITLE_MAX = 80;
const BODY_MAX = 140;
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 通知の中身 (純粋関数)。見出し = 差出人、本文 = 件名 + 本文の冒頭。 */
export function buildNewMailNotify(message: mail.MailMessage, ownerUserId: string): notification.NotifyRequest {
  const sender = message.from.name?.trim() || message.from.email;
  const subject = message.subject.trim() || "（件名なし）";
  const snippet = message.snippet.replace(/\s+/g, " ").trim();
  return {
    type: mail.MAIL_RECEIVED_NOTIFY_TYPE,
    recipientIds: [ownerUserId],
    title: cut(`${sender} さんからメールが届きました`, TITLE_MAX),
    body: cut(snippet ? `${subject}\n${snippet}` : subject, BODY_MAX),
    // in_app (push は自動で付く)。メールの着信をメールで知らせることはしない。
    channels: ["in_app"],
    dedupKey: `${mail.MAIL_RECEIVED_NOTIFY_TYPE}:${message.id}:${ownerUserId}`,
    resourceType: mail.MAIL_RECEIVED_RESOURCE_TYPE,
    resourceId: message.id,
  };
}

/** 決して throw しない。 */
export async function notifyNewMail(
  port: NewMailNotifyPort | undefined,
  ctx: RequestContext,
  message: mail.MailMessage,
  ownerUserId: string,
): Promise<void> {
  if (!port) return;
  try {
    await port.notify(ctx, buildNewMailNotify(message, ownerUserId));
  } catch (err) {
    consoleSink({
      level: "warn",
      message: "mail-gateway: new-mail notification failed",
      service: SERVICE_NAME,
      requestId: ctx.requestId,
      fields: { inboundId: message.id, ownerUserId, error: err instanceof Error ? err.message : String(err) },
    });
  }
}
