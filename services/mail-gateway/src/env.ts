// Worker bindings (wrangler.toml) + Hono per-request variables.
// Deploy is out of scope for this unit; every Service Binding / Queue is contract-only.
import type { D1Database, Fetcher, Queue, R2Bucket } from "@cloudflare/workers-types";
import type { AuthClient, AuthnContext } from "@dub/auth-client";
import type { AuditRecordEnvelopeV1, DubEventEnvelope } from "@dub/events";
import type { RequestContext } from "@dub/http";

export interface Env {
  // --- data ---
  DB: D1Database; // shared dub-core D1 (mail_ namespace + freeq_outbox on free tier)

  // --- attachment body store (R2 free tier 10GB; bucket dub-mail-attachments) ---
  // Optional: when absent the gateway degrades gracefully — send rejects attachments
  // (loud 400) and inbound skips attachment extraction (headers/snippet unchanged). D1
  // keeps only metadata; the file bytes live here keyed by mail_attachments.r2_key.
  R2_MAIL?: R2Bucket;

  // --- queue producers (PAID plan only) ---
  // Optional: on the Workers FREE plan these bindings are absent and deps.ts falls
  // back to a @dub/freeq D1 outbox shim (see outbox.ts / drain.ts). When present
  // (paid deploy, wrangler.toml) the real Queues are used unchanged.
  AUDIT_QUEUE?: Queue<AuditRecordEnvelopeV1>; // publishAudit channel (theme13)
  EVT_MAIL_AUTOMATION?: Queue<DubEventEnvelope>; // mail.message.received consumer
  EVT_NOTIFICATION?: Queue<DubEventEnvelope>; // mail.message.sent / send_failed consumer

  // --- service bindings ---
  SVC_IDENTITY: Fetcher; // POST /authz/check (mail:* permissions)
  SVC_AUDIT?: Fetcher; // audit-log (free-tier outbox drain delivery target); absent => drain skips audit

  // --- outbound provider config (Workers Secrets; real send credentials) ---
  MAIL_OUTBOUND_PROVIDER?: string; // "resend" (default, ADR-0001) | "ses" | "mailchannels" | "mock"
  MAIL_FROM_ADDRESS?: string; // default From (e.g. info@developershub.jp)
  // Fixed archive address auto-CC'd on EVERY send (compliance archive). Non-secret
  // [vars]; defaults to archive@developershub.jp when unset. Empty string disables it.
  MAIL_ARCHIVE_CC?: string;

  // SES (SigV4-signed HTTPS). Secrets: SES_ACCESS_KEY_ID / SES_SECRET_ACCESS_KEY.
  SES_REGION?: string;
  SES_ACCESS_KEY_ID?: string;
  SES_SECRET_ACCESS_KEY?: string;

  // Resend / MailChannels (Bearer / X-Api-Key). Secrets, never committed.
  RESEND_API_KEY?: string;
  MAILCHANNELS_API_KEY?: string;

  // --- Cloudflare Email Routing admin (address issuance + forwarding rules) ---
  // The proxy behind /mail/admin/email-routing/*. The API token is a Workers Secret
  // (NEVER committed / logged / echoed). When it is absent every admin endpoint returns
  // 503 (MAIL_EMAIL_ROUTING_UNCONFIGURED) so the feature fails loud, never silently.
  //   CF_EMAIL_ROUTING_TOKEN  — secret. Needs `Zone:Email Routing Rules:Edit` on the
  //     target zone AND `Account:Email Routing Addresses:Edit` (destination addresses are
  //     account-scoped). See README "Email Routing admin" for the exact scopes.
  CF_EMAIL_ROUTING_TOKEN?: string;
  // Non-secret ids (safe as [vars]). Rules are zone-scoped, destination addresses are
  // account-scoped, so both ids are required for the full surface.
  CF_EMAIL_ROUTING_ZONE_ID?: string; // developershub.jp zone id (rules API)
  CF_EMAIL_ROUTING_ACCOUNT_ID?: string; // account id (destination addresses API)
  CF_EMAIL_ROUTING_ZONE_NAME?: string; // zone apex, default developershub.jp (anti-spoof matcher check)

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
