// Worker bindings (wrangler.toml) + Hono per-request variables.
// Deploy is out of scope for this unit; every Service Binding is contract-only.
import type { D1Database, Fetcher, Queue } from "@cloudflare/workers-types";
import type { AuthClient, AuthnContext } from "@dub/auth-client";
import type { AuditRecordEnvelopeV1 } from "@dub/events";
import type { RequestContext } from "@dub/http";

export interface Env {
  // --- data ---
  DB: D1Database; // shared dub-core D1 (notif_ namespace only)

  // --- queue producers ---
  AUDIT_QUEUE: Queue<AuditRecordEnvelopeV1>; // publishAudit channel (theme13)

  // --- service bindings ---
  // identity/event are required. mail/chat/push are optional: their adapters call the
  // real downstream port through this binding when present, and record "skipped"
  // (detail=channel_not_wired) when the binding is absent — never a fake/stub delivery.
  SVC_IDENTITY: Fetcher; // roles expansion + email resolution + authz/check
  SVC_EVENT: Fetcher; // GET /events/:id/participants
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
