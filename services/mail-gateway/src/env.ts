// Worker bindings (wrangler.toml) + Hono per-request variables.
// Deploy is out of scope for this unit; every Service Binding / Queue is contract-only.
import type { D1Database, Fetcher, Queue, R2Bucket } from "@cloudflare/workers-types";
import type { AuditRecordEnvelopeV1, DubEventEnvelope } from "@dub/events";
import type { RequestContext } from "@dub/http";
import type { PolicyGateVars } from "@dub/policy-gate";

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
  SVC_MEMBER?: Fetcher; // member-service: userId -> 名簿 Gmail (Gmail safety-net forward); absent => no forward
  SVC_NOTIFICATION?: Fetcher; // notification POST /notify: in-app admin alert for Resend delivery problems; absent => audit + log only

  // --- Gmail safety-net forward (gmail-forward.ts) ---
  // "on" forwards each inbound copy to the envelope recipient's linked 名簿 Gmail. Anything
  // else (default: unset) = OFF. Each Gmail must first be a VERIFIED Email Routing
  // destination address, or forward() fails (recorded, never blocks ingest).
  MAIL_GMAIL_FORWARD?: string;
  // Every inbound mail is also forwarded (once per Message-ID) to this single address.
  // Unset/empty = off. Independent of MAIL_GMAIL_FORWARD. Must be a VERIFIED Email Routing
  // destination, or forward() fails (logged + audited, storage unaffected).
  MAIL_ARCHIVE_FORWARD_TO?: string;

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
  // Resend webhook signing secret ("whsec_..."; Svix). Unset => POST /internal/webhooks/resend
  // answers 503 (fail closed) and config-check reports it. See resend-webhook.ts.
  RESEND_WEBHOOK_SECRET?: string;

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
  // The Email Routing "send to a Worker" target for an ISSUED receiving address: this
  // service's own deployed Worker name (must be enabled as an email Worker on the zone).
  // Default dub-mail-gateway (the free-tier prod name). Non-secret [vars].
  CF_EMAIL_ROUTING_WORKER_NAME?: string;

  // --- destructive-operation guard (destructive.ts) ---
  // "on" permits guardedBulkDelete (soft-delete -> grace -> purge). Anything else (default:
  // unset) refuses every bulk delete. Turn on only for an owner-approved, one-off operation.
  MAIL_DESTRUCTIVE_OPS?: string;

  // --- send resilience tuning (non-secret [vars]; optional, sane defaults) ---
  MAIL_SEND_MAX_ATTEMPTS?: string; // integer 1..6 (default 3)
  MAIL_SEND_TIMEOUT_MS?: string; // per-attempt upstream timeout ms (default 15000)
  MAIL_RATE_LIMIT_COOLDOWN_SEC?: string; // "recently rate-limited" window, 5..86400 (default 60)

  // --- production synthetic mail monitor (canary.ts; non-secret [vars]) ---
  // OFF unless MAIL_CANARY_ENABLED="true" AND both QA addresses are set (and differ).
  MAIL_CANARY_ENABLED?: string;
  MAIL_CANARY_TO?: string; // dedicated QA address (To) — must route to this Worker, NOT a roster user
  MAIL_CANARY_CC?: string; // second QA address (Cc)
  MAIL_CANARY_EXPECT_CC?: string; // "true" = a missing Cc copy fails the probe (default: recorded only)
  MAIL_CANARY_INTERVAL_MIN?: string; // send every N minutes, multiple of 5 (default 15)
  MAIL_CANARY_DEADLINE_MIN?: string; // arrival deadline per probe (default 10)
}

// Hono per-request variables.
//
// `userId` comes from PolicyGateVars: policyGate (app.ts) publishes the authenticated caller
// on every key-gated route, so handlers read `c.get("userId")` instead of re-reading the
// trusted header. The former `authClient` / `authn` vars are gone with `withAuth` — authn is
// the gate's job now, and the one remaining handler-side authz question (`mail:read_all`, a
// per-account scope decision) builds its own client where it is asked.
export interface Vars extends PolicyGateVars {
  dubCtx: RequestContext;
}

export type AppBindings = { Bindings: Env; Variables: Vars };
