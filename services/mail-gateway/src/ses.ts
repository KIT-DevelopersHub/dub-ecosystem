// Amazon SES outbound provider (ADR-001). Calls the SES v2 SendEmail HTTPS API
// (POST /v2/email/outbound-emails) with a SigV4-signed request — no SMTP, no AWS SDK.
// The assembled RFC822 MIME is sent as Raw content so threading (In-Reply-To/References)
// and loop-prevention headers survive intact. Region defaults to ap-northeast-1 (東京).
//
// Safe-side failure posture: any signing/transport/non-2xx/sandbox rejection throws
// DubError(MAIL_PROVIDER_UNAVAILABLE, 502); the send core then records the failure,
// publishes mail.message.send_failed and audits it — mail is never silently dropped.
import { DubError } from "@dub/errors";
import type { Env } from "./env";
import { safeErrorDetail } from "./provider-error";
import type { MailProvider, OutboundMail } from "./provider";
import { signRequest } from "./sigv4";

const SES_SERVICE = "ses";
export const DEFAULT_SES_REGION = "ap-northeast-1";
const SES_PATH = "/v2/email/outbound-emails";

export interface SesProviderConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** UTF-8 -> base64 (SES Raw.Data wants base64 of the raw MIME bytes). */
function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export class SesMailProvider implements MailProvider {
  readonly name = "ses" as const;
  constructor(private readonly cfg: SesProviderConfig) {}

  async send(msg: OutboundMail): Promise<{ providerMessageId: string }> {
    const host = `email.${this.cfg.region}.amazonaws.com`;
    const body = JSON.stringify({
      FromEmailAddress: msg.from,
      Destination: {
        ToAddresses: msg.to.map((a) => a.email),
        ...(msg.cc.length > 0 ? { CcAddresses: msg.cc.map((a) => a.email) } : {}),
      },
      Content: { Raw: { Data: base64Utf8(msg.mime) } },
    });

    let headers: Record<string, string>;
    try {
      headers = await signRequest({
        method: "POST",
        host,
        path: SES_PATH,
        service: SES_SERVICE,
        region: this.cfg.region,
        accessKeyId: this.cfg.accessKeyId,
        secretAccessKey: this.cfg.secretAccessKey,
        payload: body,
      });
    } catch (err) {
      throw new DubError("MAIL_PROVIDER_UNAVAILABLE", "failed to sign SES request", { status: 502, cause: err });
    }

    const doFetch = this.cfg.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`https://${host}${SES_PATH}`, { method: "POST", headers, body });
    } catch (err) {
      throw new DubError("MAIL_PROVIDER_UNAVAILABLE", "SES request failed", { status: 502, cause: err });
    }

    if (!res.ok) {
      const detail = await safeErrorDetail(res, ["message", "Message", "__type"]);
      throw new DubError(
        "MAIL_PROVIDER_UNAVAILABLE",
        `SES rejected the message (${res.status})${detail ? `: ${detail}` : ""}`,
        { status: 502 },
      );
    }

    const parsed = (await res.json().catch(() => null)) as { MessageId?: string } | null;
    if (!parsed?.MessageId) {
      throw new DubError("MAIL_PROVIDER_UNAVAILABLE", "SES returned no MessageId", { status: 502 });
    }
    return { providerMessageId: parsed.MessageId };
  }
}

/**
 * Build SES config from Env, or null when credentials are absent — the caller then
 * keeps the loud UnwiredMailProvider stub rather than a half-configured client, so a
 * mis-provisioned environment fails loudly instead of silently dropping mail.
 * Real values live in Workers Secrets (SES_ACCESS_KEY_ID / SES_SECRET_ACCESS_KEY);
 * none are committed.
 */
export function sesConfigFromEnv(env: Env): SesProviderConfig | null {
  const accessKeyId = env.SES_ACCESS_KEY_ID;
  const secretAccessKey = env.SES_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return null;
  return { region: env.SES_REGION || DEFAULT_SES_REGION, accessKeyId, secretAccessKey };
}
