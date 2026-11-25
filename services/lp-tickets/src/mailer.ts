// 購入者へのメール送信。Resend の REST API を直接呼ぶ（mail-gateway は通さない）。
// チケット URL は資格情報なので、dub-core のメールログやアーカイブ BCC に残してはいけない。
// エラーは短い理由コードだけを返す: 応答の message は宛先を含むことがあるので使わない。

const RESEND_ENDPOINT = "https://api.resend.com/emails";
export const MAIL_TIMEOUT_MS = 10_000;

export interface MailAttachment {
  filename: string;
  contentBase64: string;
  contentType: string;
}

export interface OutboundMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: MailAttachment[];
}

/**
 * rate_limited / transient = the mail or the address is not at fault: retried without counting.
 * rejected = counted, so an address Resend keeps refusing ends in 'failed'.
 */
export type MailResult =
  | { ok: true; id: string }
  | { ok: false; failure: "rate_limited" | "transient" | "rejected"; error: string; retryAfterSec?: number };

export interface Mailer {
  /** Never throws. The same key inside Resend's idempotency window does not send twice. */
  send(mail: OutboundMail, idempotencyKey: string): Promise<MailResult>;
}

function failureOf(status: number): "rate_limited" | "transient" | "rejected" {
  if (status === 429) return "rate_limited";
  // 401 / 403 = our API key or sending domain. Counting them would burn every buyer's attempts.
  if (status >= 500 || status === 401 || status === 403) return "transient";
  return "rejected";
}

async function errorName(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { name?: unknown } | null;
  return typeof body?.name === "string" && /^[a-z0-9_]{1,40}$/.test(body.name) ? body.name : "unknown";
}

export function createResendMailer(apiKey: string, fetchImpl: typeof fetch = fetch, timeoutMs = MAIL_TIMEOUT_MS): Mailer {
  return {
    async send(mail, idempotencyKey) {
      const body = JSON.stringify({
        from: mail.from,
        to: [mail.to],
        subject: mail.subject.replace(/[\r\n]+/g, " "),
        text: mail.text,
        ...(mail.html ? { html: mail.html } : {}),
        ...(mail.attachments?.length
          ? {
              attachments: mail.attachments.map((a) => ({
                filename: a.filename,
                content: a.contentBase64,
                content_type: a.contentType,
              })),
            }
          : {}),
      });
      let res: Response;
      try {
        res = await fetchImpl(RESEND_ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
            "idempotency-key": idempotencyKey,
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        return { ok: false, failure: "transient", error: (e as Error)?.name === "TimeoutError" ? "timeout" : "network_error" };
      }
      if (!res.ok) {
        const failure = failureOf(res.status);
        const retryAfter = Number(res.headers.get("retry-after"));
        return {
          ok: false,
          failure,
          error: `resend_${res.status}_${await errorName(res)}`,
          ...(failure === "rate_limited" && retryAfter > 0 ? { retryAfterSec: retryAfter } : {}),
        };
      }
      const parsed = (await res.json().catch(() => null)) as { id?: unknown } | null;
      if (typeof parsed?.id !== "string" || !parsed.id) return { ok: false, failure: "transient", error: "resend_no_id" };
      return { ok: true, id: parsed.id };
    },
  };
}
