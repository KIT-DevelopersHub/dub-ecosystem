// MailChannels outbound provider (managed ESP option; ADR-001 alternative to SES).
// Calls the MailChannels Email API (POST https://api.mailchannels.net/tx/v1/send)
// with an API key in the X-Api-Key header. The API builds its own MIME from the
// structured fields, so we pass from/to/cc/subject/text/html rather than the raw
// RFC822 blob; threading + loop-prevention headers are forwarded via `headers`.
//
// Safe-side failure posture (identical to ses.ts): any transport/non-2xx/empty-id
// outcome throws DubError(MAIL_PROVIDER_UNAVAILABLE, 502); the send core records the
// failure, publishes mail.message.send_failed and audits it — mail is never dropped.
import { DubError } from "@dub/errors";
import type { mail } from "@dub/types";
import { DEFAULT_SEND_TIMEOUT_MS } from "./config";
import type { Env } from "./env";
import { retryableStatus, safeErrorDetail } from "./provider-error";
import type { MailProvider, OutboundMail } from "./provider";
import { parseTimeoutMs } from "./resilience";

const MAILCHANNELS_ENDPOINT = "https://api.mailchannels.net/tx/v1/send";

export interface MailChannelsConfig {
  apiKey: string;
  /** Per-attempt upstream timeout (ms). A hung request is aborted and retried. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** MailChannels personalization recipient shape ({ email, name? }). */
function recipient(a: mail.MailAddress): { email: string; name?: string } {
  return a.name ? { email: a.email, name: a.name } : { email: a.email };
}

export class MailChannelsMailProvider implements MailProvider {
  readonly name = "mailchannels" as const;
  constructor(private readonly cfg: MailChannelsConfig) {}

  async send(msg: OutboundMail): Promise<{ providerMessageId: string }> {
    const [fromEmail, fromName] = splitFrom(msg.from);
    // Forward threading headers the structured API would otherwise drop. We stamp
    // OUR minted Message-ID (matching the raw MIME SES sends) so a recipient's reply
    // carries it in In-Reply-To/References and the inbound handler correlates the
    // thread. Without this, MailChannels mints its own id and replies silently
    // diverge from SES — the exact break this must guards against.
    const headers: Record<string, string> = { "Message-ID": `<${msg.messageId}>` };
    if (msg.inReplyTo) {
      const ref = `<${msg.inReplyTo}>`;
      headers["In-Reply-To"] = ref;
      headers["References"] = ref;
    }

    const content: Array<{ type: string; value: string }> = [{ type: "text/plain", value: msg.textBody }];
    if (msg.htmlBody) content.push({ type: "text/html", value: msg.htmlBody });

    const body = JSON.stringify({
      personalizations: [
        {
          to: msg.to.map(recipient),
          ...(msg.cc.length > 0 ? { cc: msg.cc.map(recipient) } : {}),
        },
      ],
      from: fromName ? { email: fromEmail, name: fromName } : { email: fromEmail },
      subject: msg.subject,
      content,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });

    const doFetch = this.cfg.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(MAILCHANNELS_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.cfg.apiKey },
        body,
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS),
      });
    } catch (err) {
      // Network reset / DNS / abort(timeout): message not accepted -> retryable.
      throw new DubError("MAIL_PROVIDER_UNAVAILABLE", "MailChannels request failed", { status: 502, cause: err, retryable: true });
    }

    if (!res.ok) {
      const detail = await safeErrorDetail(res, ["errors", "message"]);
      throw new DubError(
        "MAIL_PROVIDER_UNAVAILABLE",
        `MailChannels rejected the message (${res.status})${detail ? `: ${detail}` : ""}`,
        { status: 502, retryable: retryableStatus(res.status) },
      );
    }

    // 202 Accepted returns { request_id, message_ids: [...] }. Fall back to our own
    // Message-Id if the payload omits one (still a success — never silent-drop).
    const parsed = (await res.json().catch(() => null)) as
      | { request_id?: string; message_ids?: string[] }
      | null;
    const providerMessageId = parsed?.message_ids?.[0] ?? parsed?.request_id ?? msg.messageId;
    return { providerMessageId };
  }
}

/** Split a header From value ("Name <email>" or bare "email") into [email, name?]. */
function splitFrom(from: string): [string, string | undefined] {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  if (m) {
    const name = m[1]!.replace(/^"|"$/g, "").trim();
    return [m[2]!.trim(), name || undefined];
  }
  return [from.trim(), undefined];
}

/**
 * Build MailChannels config from Env, or null when the API key is absent — the caller
 * then keeps the loud UnwiredMailProvider stub rather than a half-configured client, so
 * a mis-provisioned environment fails loudly instead of silently dropping mail. The key
 * lives in a Workers Secret (MAILCHANNELS_API_KEY); it is never committed.
 */
export function mailchannelsConfigFromEnv(env: Env): MailChannelsConfig | null {
  const apiKey = env.MAILCHANNELS_API_KEY;
  if (typeof apiKey !== "string" || !apiKey) return null;
  return { apiKey, timeoutMs: parseTimeoutMs(env) };
}
