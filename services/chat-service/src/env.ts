// Worker bindings for chat-service. Extracted from index.ts so the Cron drain
// (drain.ts) can share the Env type without an index <-> drain runtime cycle.
//
// FREE-TIER shape: the chat.* fan-out queue (EVT_NOTIFICATION) and the audit channel
// (AUDIT_QUEUE) are PAID Cloudflare Queues and are therefore OPTIONAL. On a free-plan
// deploy they are absent and the publishers fall back to a @dub/freeq D1 outbox
// (freeq_outbox on the shared dub-core DB); a Cron-triggered drain forwards audit rows
// to audit-log and defers domain events (kept durable/pending). When the real Queue
// bindings ARE present (paid deploy, wrangler.toml) they are used unchanged.
//
// The ChatRoom Durable Object (RT hub) is NOT a paid Queue — SQLite-backed DOs run on
// the free plan — so it is preserved verbatim (CHAT_ROOM namespace + WS routing).
import type { D1Database, Fetcher, Queue, DurableObjectNamespace } from "@cloudflare/workers-types";
import type { ChatRoom } from "./chat-room-do";

export interface Env {
  DB: D1Database; // shared dub-core D1 (chat_* namespace + un-namespaced freeq_outbox)
  SVC_IDENTITY: Fetcher; // identity-roster (authz)
  SVC_EVENT?: Fetcher; // event-service (read-only eventExists check)
  SVC_FILE_META?: Fetcher; // file-meta (best-effort message<->file link registration)
  SVC_AUDIT?: Fetcher; // audit-log (free-tier outbox drain delivery target); absent => drain defers audit

  // chat.* fan-out queue + audit channel (PAID plan only; absent => @dub/freeq outbox fallback).
  EVT_NOTIFICATION?: Queue; // sole subscriber of chat.* is notification
  AUDIT_QUEUE?: Queue; // audit channel (PAID plan only; absent => outbox fallback)

  // ChatRoom DO namespace (RT fanout). Absent in local/preview -> Noop publisher.
  // Free-tier compatible (SQLite-backed DO); preserved as the realtime hub.
  CHAT_ROOM?: DurableObjectNamespace<ChatRoom>;

  DUB_DEFAULT_ORG_ID?: string;
  CHAT_RT_DO_URL_BASE?: string;
  WS_TICKET_SECRET?: string;
}
