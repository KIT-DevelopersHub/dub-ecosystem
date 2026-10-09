// Service-internal types — the adapter machinery that the frozen @dub/types mail
// namespace deliberately leaves to the implementation. Public HTTP / event I/O
// ALWAYS uses @dub/types / @dub/events; nothing here is a wire type.
import type { mail } from "@dub/types";
import type { AuditRecordEnvelopeV1, DubEventEnvelope } from "@dub/events";
import type { Fetcher, Queue } from "@cloudflare/workers-types";
import type { DbClient } from "@dub/db";
import type { RequestContext } from "@dub/http";
import type { MailProvider } from "./provider";
import type { MailBlobStore } from "./attachments";
import type { RetryOptions } from "./retry";

// The publish targets publishEvent(env, ...) needs: keyed by the frozen queue binding
// names in @dub/events CONSUMER_QUEUE_BINDINGS. The string index signature keeps it
// assignable to @dub/events DubEventPublisherEnv (Partial<Record<string, Queue>>).
export type EventPublishEnv = Record<string, Queue<DubEventEnvelope>> & {
  EVT_MAIL_AUTOMATION: Queue<DubEventEnvelope>;
  EVT_NOTIFICATION: Queue<DubEventEnvelope>;
};
export interface AuditEnv {
  AUDIT_QUEUE: Queue<AuditRecordEnvelopeV1>;
}

// Everything a single send / inbound operation needs. The app builds this from the
// Worker Env; tests build it with in-memory fakes (design test — implementation交換).
export interface SendDeps {
  db: DbClient;
  provider: MailProvider;
  events: EventPublishEnv;
  audit: AuditEnv;
  orgId: string;
  fromAddress: string;
  ctx: RequestContext;
  /** Owner (Sent-folder account scope): the user who composed the send, or null for a
   *  pure system/automation send with no human on the call. Persisted on the send-log so
   *  GET /mail/sent can return only the signed-in user's own mail. */
  ownerUserId?: string | null;
  /** Fixed archive address auto-CC'd on this send (compliance archive). null/empty =
   *  disabled. Deduplicated against the existing To/Cc so a caller who already addressed
   *  it is never CC'd twice. */
  archiveCc?: string | null;
  /** Retry budget for the provider call (transient failures only). Optional — the send
   *  core falls back to the built-in defaults when absent (tests omit it). */
  retry?: Pick<RetryOptions, "maxAttempts" | "baseDelayMs">;
  /** Attachment body store (R2). Absent => attachments are rejected at validation and
   *  never stored (feature degrades loudly, never silently drops a file). */
  blobs?: MailBlobStore;
}

export interface InboundDeps {
  db: DbClient;
  events: EventPublishEnv;
  audit: AuditEnv;
  orgId: string;
  ctx: RequestContext;
  /** Attachment body store (R2). Absent => inbound attachment extraction is skipped
   *  (headers/snippet/body ingest is unchanged). */
  blobs?: MailBlobStore;
  /** identity-roster binding (internal S2S). Used to resolve the recipient address of an
   *  inbound message to a roster userId (Inbox account scope). Optional so unit tests that
   *  don't exercise owner resolution can omit it (owner then resolves to null). */
  identity?: Fetcher;
  /** Compliance archive address (MAIL_ARCHIVE_CC) — excluded from owner resolution.
   *  See OwnerAddressPolicy.archiveAddress. */
  archiveAddress?: string | null;
  /** Shared system address (MAIL_FROM_ADDRESS) — owner only as a last resort.
   *  See OwnerAddressPolicy.sharedAddress. */
  sharedAddress?: string | null;
}

// Normalized inbound message parsed from a raw RFC822 message (Email Routing).
export interface ParsedInbound {
  message: mail.MailMessage; // frozen DTO (no body field — snippet only)
  loop: mail.MailLoopHeaders; // loop-prevention hints (passthrough; no logic here)
  mailbox: string | null; // destination mailbox id (best-effort local-part)
  bodyText: string; // full plain-text body (persisted alongside; powers the detail view)
  htmlBody: string | null; // HTML part when present (sanitized before render); NULL otherwise
  // Ordered ancestral Message-Ids this message references (all References tokens, then
  // In-Reply-To; most-ancestral first). Used to NORMALIZE thread_id against known messages
  // so a trimmed References chain still joins the root conversation (改善#3). Empty for a
  // brand-new (unreferenced) message.
  references: string[];
  // Owner-resolution candidates, MOST AUTHORITATIVE FIRST: the envelope recipient (the
  // address Email Routing actually delivered this copy to) followed by the To: header
  // addresses. Envelope-first because To: holds an external address whenever we are only
  // in CC/BCC — resolving from To: alone left those messages ownerless (invisible).
  // Shared/system addresses are demoted or dropped per OwnerAddressPolicy.
  ownerCandidates: mail.MailAddress[];
}

/**
 * Which delivery addresses may own an inbound message (mail visibility boundary — keep
 * this conservative). Both are plain addresses; empty/absent disables that rule.
 */
export interface OwnerAddressPolicy {
  /** Compliance archive address (MAIL_ARCHIVE_CC, e.g. archive@). EVERY outbound send is
   *  auto-CC'd here and the copy is routed back in, so if it could own a message the
   *  whole company's sent mail would become one account's ordinary Inbox. config.ts
   *  defines these copies as mail:read_all (oversight) material only → NEVER an owner,
   *  in any candidate position. */
  archiveAddress?: string | null;
  /** Shared system address (MAIL_FROM_ADDRESS, e.g. info@). A genuine shared inbox, so it
   *  MAY own a message — but it is tried only AFTER the To: header so that mail addressed
   *  to an individual is not re-homed to the shared account (and hidden from its real
   *  recipient) just because it was routed through the alias. */
  sharedAddress?: string | null;
}

// ---- reconciled cross-service inbound DTO (統合波 reconcile, 2026-08) ----
// The inbound-message VIEW shared by mail-gateway (producer: GET /messages/:id,
// /threads/:id) and mail-automation (consumer). Anchored on the frozen @dub/types
// `mail.MailMessage`; the enrichment fields below are OPTIONAL supersets that
// `@dub/types` deliberately omits but automation's loop-detection + rule evaluation
// need (list-id, x-dub-event-tag, References depth). @dub/types is frozen and the
// repo shares types only via @dub/* packages (no service→service imports), so the
// two definitions are kept structurally IDENTICAL and both `extends mail.MailMessage`.
// mail-automation/src/types.ts mirrors this exact shape — that mirror + this shared
// anchor is what resolves the former "統合波でreconcile" gap.
export interface InboundMailView extends mail.MailMessage {
  /** Receiving mailbox local-part / address; falls back to the first recipient. */
  mailbox?: string;
  /** Lower-cased raw header map used by loop detection + rule fields (list-id等). */
  headers?: Record<string, string>;
  /** RFC References chain (thread-depth signal). */
  references?: string[];
}
