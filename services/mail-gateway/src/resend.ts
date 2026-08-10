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
import { DEFAULT_SEND_TIMEOUT_MS } from "./config";
import type { Env } from "./env";
import { retryableStatus, safeErrorDetail } from "./provider-error";
import { rateLimitError } from "./rate-limit";
import type { MailProvider, OutboundMail } from "./provider";
import { parseTimeoutMs } from "./resilience";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface ResendConfig {
  apiKey: string;
  /** Per-attempt upstream timeout (ms). A hung request is aborted and retried. */
  timeoutMs?: number;
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
    // We stamp OUR minted Message-ID (matching the raw MIME SES sends) so a
    // recipient's reply carries it in In-Reply-To/References and the inbound handler
    // correlates the thread.
    //
    // CONSTRAINT (verified 2026-08, Resend docs "Custom Headers"): Resend accepts a
    // `headers` map but does NOT document Message-ID as overridable and is reported to
    // generate/override its own Message-ID for deliverability (industry norm; SES does
    // the same for non-Raw sends). So on Resend this is best-effort: if Resend honors
    // it, threading matches SES/MailChannels; if Resend overrides it, replies thread
    // against Resend's id, not our minted one. We still send it (harmless if ignored,
    // correct if honored) rather than silently omit it. SES (raw MIME) and MailChannels
    // (honors custom Message-ID) are the deterministic paths; Resend carries this caveat.
    const headers: Record<string, string> = { "Message-ID": `<${msg.messageId}>` };
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
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS),
      });
    } catch (err) {
      // Network reset / DNS / abort(timeout): message not accepted -> retryable.
      throw new DubError("MAIL_PROVIDER_UNAVAILABLE", "Resend request failed", { status: 502, cause: err, retryable: true });
    }

    if (!res.ok) {
      const detail = await safeErrorDetail(res, ["message", "name"]);
      // 429 is a distinct quota signal (surfaced to the admin UI), not a generic 502.
      if (res.status === 429) throw rateLimitError("Resend", res, detail);
      throw new DubError(
        "MAIL_PROVIDER_UNAVAILABLE",
        `Resend rejected the message (${res.status})${detail ? `: ${detail}` : ""}`,
        { status: 502, retryable: retryableStatus(res.status) },
      );
    }

    // 200 OK returns { id: "..." }. A 2xx without an id is a contract violation → loud.
    const parsed = (await res.json().catch(() => null)) as { id?: string } | null;
    if (!parsed?.id) {
      throw new DubError("MAIL_PROVIDER_UNAVAILABLE", "Resend returned no id", { status: 502, retryable: false });
    }
    return { providerMessageId: parsed.id };
  }
}

/**
 * Build Resend config from Env, or null when the API key is absent — the caller then
 * keeps the loud UnwiredMailProvider stub rather than a half-configured client, so a
 * mis-provisioned environment fails loudly instead of silently dropping mail. The key
 * lives in a Workers Secret (RESEND_API_KEY); it is never committed.
 */
export function resendConfigFromEnv(env: Env): ResendConfig | null {
  const apiKey = env.RESEND_API_KEY;
  if (typeof apiKey !== "string" || !apiKey) return null;
  return { apiKey, timeoutMs: parseTimeoutMs(env) };
}
