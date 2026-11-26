// freeq-drain bindings. Four @dub/freeq outbox D1s (the drain reads due pending rows
// from each) and the live consumer service bindings the routing map forwards to. Every
// binding is optional: a missing D1 is skipped and a missing service binding makes its
// topic DEFER (row stays durable/pending) rather than crash the drain.
import type { D1Database, DurableObjectNamespace, Fetcher } from "@cloudflare/workers-types";

export interface Env {
  // --- the alarm-loop Durable Object that drives the drain (replaces the cron trigger) ---
  DRAIN_DO?: DurableObjectNamespace; // POST /internal/drain/kick bootstraps its self-rescheduling alarm

  // --- freeq outbox D1s (one drain pass each) ---
  DB_CORE?: D1Database; // shared dub-core outbox (audit-log, chat, deploy, event, file-meta, github-sync, identity-roster, mail-gateway, notification, task)
  DB_AUTH?: D1Database; // auth-service's separate auth-outbox
  DB_DRIVE?: D1Database; // alias of dub-core (drive-proxy writes there); NOT drained separately
  DB_MOBILE?: D1Database; // alias of dub-core (mo3-mobile-bff writes there); NOT drained separately

  // --- live consumer service bindings (routing destinations) ---
  SVC_AUDIT_LOG?: Fetcher; // audit-log       POST /internal/audit-async
  SVC_NOTIFICATION?: Fetcher; // notification  POST /internal/events-async (evt.notification)
  SVC_TASK?: Fetcher; // task-service     POST /internal/events-async
  SVC_GANTT?: Fetcher; // gantt-service    POST /internal/events-async
  SVC_FILE_META?: Fetcher; // file-meta        POST /internal/events-async
  SVC_GITHUB_SYNC?: Fetcher; // github-sync      POST /internal/events-async
  SVC_MOBILE_BFF?: Fetcher; // mo3-mobile-bff   POST /internal/events-async
  SVC_MAIL_AUTOMATION?: Fetcher; // mail-automation POST /internal/events-async (改善#5)
  SVC_CHAT?: Fetcher; // chat-service    POST /internal/events-async (evt.chat, #850 times channel)

  // --- write guard (#841): max outbox rows claimed per UTC day (default 3000; "0" pauses) ---
  FREEQ_DAILY_ROW_CAP?: string;
}

// The env keys that hold a consumer service binding (used by the routing map).
export type ServiceBindingName =
  | "SVC_AUDIT_LOG"
  | "SVC_NOTIFICATION"
  | "SVC_TASK"
  | "SVC_GANTT"
  | "SVC_FILE_META"
  | "SVC_GITHUB_SYNC"
  | "SVC_MOBILE_BFF"
  | "SVC_MAIL_AUTOMATION"
  | "SVC_CHAT";

// The env keys that hold a freeq outbox D1, drained in this fixed order each tick.
// ONE entry per PHYSICAL D1: only dub-core and auth-outbox exist. DB_DRIVE / DB_MOBILE are
// aliases of dub-core (wrangler.toml), so draining them too ran the same table 3x per tick
// and tripled the per-invocation subrequest count — the Free plan's 50-subrequest cap was
// blown every tick ("Too many subrequests by single Worker invocation", 2026-09).
export const OUTBOX_DB_BINDINGS = ["DB_CORE", "DB_AUTH"] as const;
export type OutboxDbBinding = (typeof OUTBOX_DB_BINDINGS)[number];
