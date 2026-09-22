// Worker bindings (wrangler.toml) + Hono per-request variables.
// Deploy is out of scope for this unit; every Service Binding is contract-only.
import type { D1Database, DurableObjectNamespace, Fetcher, Queue } from "@cloudflare/workers-types";
import type { AuthClient, AuthnContext } from "@dub/auth-client";
import type { AuditRecordEnvelopeV1 } from "@dub/events";
import type { RequestContext } from "@dub/http";
import type { InboxRoom } from "./inbox-room-do";

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

  // --- realtime (inbox WS push) ---
  // Per-user InboxRoom Durable Object (SQLite-backed, free-tier). ingest signals a
  // recipient's live sockets after an in_app row commits; absent -> realtime is a noop and
  // the fe5 60s poller is the only path. DO-direct WS (gateway-bypassing) needs this
  // worker's workers.dev subdomain enabled (see wrangler.free.toml).
  INBOX_ROOM?: DurableObjectNamespace<InboxRoom>;
  // HMAC secret the InboxRoom DO verifies ws-tickets with (Worker Secret in prod). Absent
  // -> a dev-only fallback (must match the DO's) so `wrangler dev` works.
  WS_TICKET_SECRET?: string;
  // Absolute wss:// base for the ws-ticket doUrl; ":id" is replaced with the user id.
  // Points at THIS worker's workers.dev subdomain (the DO is co-hosted here).
  NOTIF_RT_DO_URL_BASE?: string;
  // Comma-separated Origin allow-list enforced by the InboxRoom DO (browser clients).
  NOTIF_RT_ALLOWED_ORIGINS?: string;
}

// Hono per-request variables.
export interface Vars {
  dubCtx: RequestContext;
  authClient: AuthClient;
  authn: AuthnContext;
}

export type AppBindings = { Bindings: Env; Variables: Vars };
