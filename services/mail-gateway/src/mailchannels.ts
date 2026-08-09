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
import type { Env } from "./env";
import type { MailProvider, OutboundMail } from "./provider";

const MAILCHANNELS_ENDPOINT = "https://api.mailchannels.net/tx/v1/send";

export interface MailChannelsConfig {
  apiKey: string;
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
    // Forward threading headers the structured API would otherwise drop.
    const headers: Record<string, string> = {};
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
      });
    } catch (err) {
      throw new DubError("MAIL_PROVIDER_UNAVAILABLE", "MailChannels request failed", { status: 502, cause: err });
    }

    if (!res.ok) {
      const detail = await safeErrorDetail(res);
      throw new DubError(
        "MAIL_PROVIDER_UNAVAILABLE",
        `MailChannels rejected the message (${res.status})${detail ? `: ${detail}` : ""}`,
        { status: 502 },
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

/** Best-effort extraction of the MailChannels error message (never throws; never logs creds). */
async function safeErrorDetail(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    if (!text) return null;
    try {
      const j = JSON.parse(text) as { message?: string; errors?: string[] };
      if (Array.isArray(j.errors) && j.errors.length > 0) return j.errors.join("; ").slice(0, 200);
      return j.message ?? text.slice(0, 200);
    } catch {
      return text.slice(0, 200);
    }
  } catch {
    return null;
  }
}

/**
 * Build MailChannels config from Env, or null when the API key is absent — the caller
 * then keeps the loud UnwiredMailProvider stub rather than a half-configured client, so
 * a mis-provisioned environment fails loudly instead of silently dropping mail. The key
 * lives in a Workers Secret (MAILCHANNELS_API_KEY); it is never committed.
 */
export function mailchannelsConfigFromEnv(env: Env): MailChannelsConfig | null {
  const apiKey = (env as unknown as Record<string, unknown>).MAILCHANNELS_API_KEY;
  if (typeof apiKey !== "string" || !apiKey) return null;
  return { apiKey };
}
