// Worker bindings (wrangler.toml) + Hono per-request variables.
// Deploy is out of scope for this unit; every Service Binding is contract-only.
import type { D1Database, Fetcher, Queue } from "@cloudflare/workers-types";
import type { AuthClient, AuthnContext } from "@dub/auth-client";
import type { AuditRecordEnvelopeV1 } from "@dub/events";
import type { RequestContext } from "@dub/http";

export interface Env {
  // --- data ---
  DB: D1Database; // shared dub-core D1 (notif_ namespace only)

  // --- audit producer ---
  // Best-effort delivery-failed audit producer (theme13). On the Workers PAID plan this
  // binding is present and the real Cloudflare Queue is used unchanged. On the FREE plan
  // it is absent and deps.ts falls back to the @dub/freeq D1 outbox shim (outbox.ts)
  // writing to OUTBOX_DB — so the record is durably persisted, never silently dropped.
  AUDIT_QUEUE?: Queue<AuditRecordEnvelopeV1>; // publishAudit channel (theme13)
  // @dub/freeq audit outbox DB (free-tier replacement for the AUDIT_QUEUE producer). The
  // shared dub-core D1 (same physical DB as `DB`, bound separately as infra plumbing for
  // the un-namespaced freeq_outbox table). Absent on the paid deploy.
  OUTBOX_DB?: D1Database;

  // --- service bindings ---
  // identity/event are required. mail/chat/push are optional: their adapters call the
  // real downstream port through this binding when present, and record "skipped"
  // (detail=channel_not_wired) when the binding is absent — never a fake/stub delivery.
  SVC_IDENTITY: Fetcher; // roles expansion + email resolution + authz/check
  SVC_EVENT: Fetcher; // GET /events/:id/participants
  SVC_AUDIT?: Fetcher; // audit-log async ingest (free-tier outbox drain delivery target)
  SVC_MAIL_GATEWAY?: Fetcher; // POST /send (absent = EmailAdapter -> skipped)
  SVC_CHAT?: Fetcher; // POST /internal/system-messages (absent = ChatAdapter -> skipped)
  SVC_MOBILE_BFF?: Fetcher; // POST /internal/push/dispatch (absent = PushAdapter -> skipped)
}

// Hono per-request variables.
export interface Vars {
  dubCtx: RequestContext;
  authClient: AuthClient;
  authn: AuthnContext;
}

export type AppBindings = { Bindings: Env; Variables: Vars };
