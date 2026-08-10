// Worker bindings (wrangler.toml) + Hono per-request variables.
// Deploy is out of scope for this unit; every Service Binding / Queue is contract-only.
import type { D1Database, Fetcher, Queue } from "@cloudflare/workers-types";
import type { AuthClient, AuthnContext } from "@dub/auth-client";
import type { AuditRecordEnvelopeV1, DubEventEnvelope } from "@dub/events";
import type { RequestContext } from "@dub/http";

export interface Env {
  // --- data ---
  DB: D1Database; // shared dub-core D1 (mail_ namespace only)

  // --- queue producers ---
  AUDIT_QUEUE: Queue<AuditRecordEnvelopeV1>; // publishAudit channel (theme13)
  EVT_MAIL_AUTOMATION: Queue<DubEventEnvelope>; // mail.message.received consumer
  EVT_NOTIFICATION: Queue<DubEventEnvelope>; // mail.message.sent / send_failed consumer

  // --- service bindings ---
  SVC_IDENTITY: Fetcher; // POST /authz/check (mail:* permissions)

  // --- outbound provider config (Workers Secrets; real send credentials) ---
  MAIL_OUTBOUND_PROVIDER?: string; // "ses" (default) | "mailchannels" | "resend" | "mock"
  MAIL_FROM_ADDRESS?: string; // default From (e.g. info@developershub.jp)

  // SES (SigV4-signed HTTPS). Secrets: SES_ACCESS_KEY_ID / SES_SECRET_ACCESS_KEY.
  SES_REGION?: string;
  SES_ACCESS_KEY_ID?: string;
  SES_SECRET_ACCESS_KEY?: string;

  // Resend / MailChannels (Bearer / X-Api-Key). Secrets, never committed.
  RESEND_API_KEY?: string;
  MAILCHANNELS_API_KEY?: string;

  // --- send resilience tuning (non-secret [vars]; optional, sane defaults) ---
  MAIL_SEND_MAX_ATTEMPTS?: string; // integer 1..6 (default 3)
  MAIL_SEND_TIMEOUT_MS?: string; // per-attempt upstream timeout ms (default 15000)
  MAIL_RATE_LIMIT_COOLDOWN_SEC?: string; // "recently rate-limited" window, 5..86400 (default 60)
}

// Hono per-request variables.
export interface Vars {
  dubCtx: RequestContext;
  authClient: AuthClient;
  authn: AuthnContext;
}

export type AppBindings = { Bindings: Env; Variables: Vars };
