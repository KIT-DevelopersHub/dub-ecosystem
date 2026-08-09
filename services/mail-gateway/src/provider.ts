// Provider abstraction (design §2-3): keeps the managed-ESP decision out of the send
// core and the public contract. Ships the interface + a Mock (single-test-green
// requirement, テーマ15決定1) + the real managed clients: Amazon SES (ADR-001, see
// ses.ts), MailChannels and Resend (REST, see mailchannels.ts / resend.ts). Each real
// client is used only when its credentials are present; otherwise the loud stub stays.
import { DubError } from "@dub/errors";
import type { mail } from "@dub/types";
import { DEFAULT_OUTBOUND_PROVIDER } from "./config";
import type { Env } from "./env";
import { MailChannelsMailProvider, mailchannelsConfigFromEnv } from "./mailchannels";
import { ResendMailProvider, resendConfigFromEnv } from "./resend";
import { SesMailProvider, sesConfigFromEnv } from "./ses";

export type ProviderName = mail.SendMailResponse["provider"];

// A fully-assembled outbound message handed to the provider. `mime` is the RFC822
// blob (SES SendRawEmail / MailChannels raw); structured fields let simpler APIs
// (Resend) build their own payload without re-parsing.
export interface OutboundMail {
  from: string;
  to: mail.MailAddress[];
  cc: mail.MailAddress[];
  subject: string;
  textBody: string;
  htmlBody: string | null;
  messageId: string; // RFC Message-Id we minted (stamped into the MIME)
  inReplyTo: string | null;
  mime: string;
}

export interface MailProvider {
  readonly name: ProviderName;
  /** Deliver the message. Throws on transport/provider failure (send core maps it to
   *  MAIL_PROVIDER_UNAVAILABLE + mail.message.send_failed). */
  send(mail: OutboundMail): Promise<{ providerMessageId: string }>;
}

/**
 * In-memory provider used by tests and local runs. Records every send and lets a test
 * force a failure. Reports a real provider name so SendMailResponse stays contract-valid.
 */
export class MockMailProvider implements MailProvider {
  readonly name: ProviderName;
  readonly sent: OutboundMail[] = [];
  private failNext: boolean;
  constructor(opts: { name?: ProviderName; fail?: boolean } = {}) {
    this.name = opts.name ?? "ses";
    this.failNext = opts.fail ?? false;
  }
  setFail(fail: boolean): void {
    this.failNext = fail;
  }
  async send(mail: OutboundMail): Promise<{ providerMessageId: string }> {
    if (this.failNext) throw new DubError("MAIL_PROVIDER_UNAVAILABLE", "mock provider forced failure", { status: 502 });
    this.sent.push(mail);
    return { providerMessageId: `mock-${mail.messageId}` };
  }
}

/** Honest placeholder for a not-yet-wired managed provider. Throws so a mis-provisioned
 *  environment fails loudly instead of silently dropping mail. */
class UnwiredMailProvider implements MailProvider {
  constructor(readonly name: ProviderName) {}
  async send(): Promise<{ providerMessageId: string }> {
    throw new DubError("MAIL_PROVIDER_UNAVAILABLE", `${this.name} outbound not wired (P0: pending 9-B managed-send + 9-E)`, {
      status: 502,
    });
  }
}

/**
 * Select the outbound provider from Env. Each managed provider (SES via SigV4-signed
 * HTTPS, MailChannels + Resend via API-key REST) becomes its real client only when its
 * credentials are present; otherwise we fall back to the loud stub so a mis-provisioned
 * environment fails loudly instead of dropping mail. `mock` is local/preview only.
 */
export function buildProvider(env: Env): MailProvider {
  const name = (env.MAIL_OUTBOUND_PROVIDER ?? DEFAULT_OUTBOUND_PROVIDER).toLowerCase();
  if (name === "mock") return new MockMailProvider();
  if (name === "ses") return buildSesProvider(env);
  if (name === "mailchannels") return buildMailChannelsProvider(env);
  if (name === "resend") return buildResendProvider(env);
  return buildSesProvider(env);
}

/** SES client when credentials are configured, else the loud stub (never silent-drop). */
function buildSesProvider(env: Env): MailProvider {
  const cfg = sesConfigFromEnv(env);
  return cfg ? new SesMailProvider(cfg) : new UnwiredMailProvider("ses");
}

/** MailChannels client when the API key is configured, else the loud stub. */
function buildMailChannelsProvider(env: Env): MailProvider {
  const cfg = mailchannelsConfigFromEnv(env);
  return cfg ? new MailChannelsMailProvider(cfg) : new UnwiredMailProvider("mailchannels");
}

/** Resend client when the API key is configured, else the loud stub. */
function buildResendProvider(env: Env): MailProvider {
  const cfg = resendConfigFromEnv(env);
  return cfg ? new ResendMailProvider(cfg) : new UnwiredMailProvider("resend");
}
