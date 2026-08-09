// Resend outbound provider (managed ESP option; ADR-001 alternative to SES).
// Calls the Resend REST API (POST https://api.resend.com/emails) with a Bearer API
// key. Resend builds its own MIME from the structured fields, so we pass from/to/cc/
// subject/text/html rather than the raw RFC822 blob; threading headers ride along in
// the `headers` map so In-Reply-To/References survive.
//
// Safe-side failure posture (identical to ses.ts): any transport/non-2xx/empty-id
// outcome throws DubError(MAIL_PROVIDER_UNAVAILABLE, 502); the send core records the
// failure, publishes mail.message.send_failed and audits it — mail is never dropped.
import { DubError } from "@dub/errors";
import type { mail } from "@dub/types";
import type { Env } from "./env";
import type { MailProvider, OutboundMail } from "./provider";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface ResendConfig {
  apiKey: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** Resend accepts "Name <email>" or a bare address string per recipient. */
function formatAddress(a: mail.MailAddress): string {
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

export class ResendMailProvider implements MailProvider {
  readonly name = "resend" as const;
  constructor(private readonly cfg: ResendConfig) {}

  async send(msg: OutboundMail): Promise<{ providerMessageId: string }> {
    const headers: Record<string, string> = {};
    if (msg.inReplyTo) {
      const ref = `<${msg.inReplyTo}>`;
      headers["In-Reply-To"] = ref;
      headers["References"] = ref;
    }

    const body = JSON.stringify({
      from: msg.from,
      to: msg.to.map(formatAddress),
      ...(msg.cc.length > 0 ? { cc: msg.cc.map(formatAddress) } : {}),
      subject: msg.subject,
      text: msg.textBody,
      ...(msg.htmlBody ? { html: msg.htmlBody } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });

    const doFetch = this.cfg.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
        body,
      });
    } catch (err) {
      throw new DubError("MAIL_PROVIDER_UNAVAILABLE", "Resend request failed", { status: 502, cause: err });
    }

    if (!res.ok) {
      const detail = await safeErrorDetail(res);
      throw new DubError(
        "MAIL_PROVIDER_UNAVAILABLE",
        `Resend rejected the message (${res.status})${detail ? `: ${detail}` : ""}`,
        { status: 502 },
      );
    }

    // 200 OK returns { id: "..." }. A 2xx without an id is a contract violation → loud.
    const parsed = (await res.json().catch(() => null)) as { id?: string } | null;
    if (!parsed?.id) {
      throw new DubError("MAIL_PROVIDER_UNAVAILABLE", "Resend returned no id", { status: 502 });
    }
    return { providerMessageId: parsed.id };
  }
}

/** Best-effort extraction of the Resend error message (never throws; never logs creds). */
async function safeErrorDetail(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    if (!text) return null;
    try {
      const j = JSON.parse(text) as { message?: string; name?: string };
      return j.message ?? j.name ?? text.slice(0, 200);
    } catch {
      return text.slice(0, 200);
    }
  } catch {
    return null;
  }
}

/**
 * Build Resend config from Env, or null when the API key is absent — the caller then
 * keeps the loud UnwiredMailProvider stub rather than a half-configured client, so a
 * mis-provisioned environment fails loudly instead of silently dropping mail. The key
 * lives in a Workers Secret (RESEND_API_KEY); it is never committed.
 */
export function resendConfigFromEnv(env: Env): ResendConfig | null {
  const apiKey = (env as unknown as Record<string, unknown>).RESEND_API_KEY;
  if (typeof apiKey !== "string" || !apiKey) return null;
  return { apiKey };
}
