// mail — mail-gateway namespace. 2-stage (theme15 decision5):
//   ① reference types (SendMail*, MailMessage, loop headers, inbound ctx): frozen.
//   ② Mailbox/Watch types: STUB pending 9-B.
// Mail policy (判断46/50): inbound = Cloudflare Email Routing -> Worker (self-built
// app); outbound = managed provider (SES暫定). Header stubs only in foundation.
import type { ISODateTime, CursorQuery } from "./common";

// ---- query contract (GET /messages, GET /sent — same shape) ----
export interface ListMailMessagesQuery extends CursorQuery {
  threadId?: string;
}

// ── Wire contract (query params) ─────────────────────────────────────────────
// SINGLE source of truth for the query-parameter *names* mail-gateway's messages list
// endpoint puts on the wire. The server (mail-gateway validation.ts parseListMessagesQuery)
// and the OpenAPI spec (docs/openapi/mail-gateway.yaml) are reconciled against this map in
// CI (see @dub/e2e-smoke wire-params.test.ts). The Sent-folder GET (/sent) uses the SAME
// parser, so its cursor/limit/threadId keys are covered by this same entry (it is not
// separately spec'd — documenting it is a noted follow-up). See
// docs/api-contracts/_wire-contract-enforcement.md.
export const MAIL_WIRE = {
  listMailMessages: { method: "GET", path: "/messages", query: ["cursor", "limit", "threadId"] },
} as const;

// Compile-time tie: every query key the descriptor lists must be a real key of the typed
// query interface, so the descriptor and the type can never silently drift.
type _MailWireKeysAreTyped =
  (typeof MAIL_WIRE)[keyof typeof MAIL_WIRE]["query"][number] extends keyof ListMailMessagesQuery
    ? true
    : never;
const _mailWireKeyGuard: _MailWireKeysAreTyped = true;
void _mailWireKeyGuard;

// ---- ① frozen ----
export interface MailAddress {
  email: string;
  name?: string;
}
export interface SendMailRequest {
  to: MailAddress[];
  cc?: MailAddress[];
  subject: string;
  textBody: string;
  htmlBody?: string;
  inReplyTo?: string; // Message-Id being replied to
  loopHeaders?: MailLoopHeaders;
  // ADDITIVE (attachments slice; optional — omitting it is byte-identical to the frozen
  // shape). File bytes ride as base64 in the JSON body; the gateway persists them to R2
  // and hands the provider the structured attachment list. Bounded per-file / per-message
  // (see mail-gateway config). Frozen consumers that ignore it keep working unchanged.
  attachments?: MailAttachmentInput[];
}
/** One outbound attachment on a SendMailRequest: filename + MIME + base64-encoded bytes. */
export interface MailAttachmentInput {
  filename: string;
  contentType: string;
  contentBase64: string; // base64 (standard alphabet) of the raw file bytes
}
/** Stored attachment METADATA (bytes live in R2). Returned on message/sent detail so the
 *  UI can list attachments and link each to its gateway download route. */
export interface MailAttachment {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  // ADDITIVE (改善#2 大容量対策): persistence status. Omitted/"stored" = bytes are in R2 and
  // downloadable (the frozen behaviour). A "dropped_*" status marks an attachment the gateway
  // could NOT store — too large for the per-file/total ceiling, or the inbound MIME was
  // truncated before its bytes arrived — so the UI surfaces it (disabled chip + reason)
  // instead of the file silently vanishing. sizeBytes carries the DECLARED size when known
  // (0 when unknown, e.g. a truncated tail). Download routes reject a non-"stored" id.
  status?: "stored" | "dropped_too_large" | "dropped_truncated";
}
export interface SendMailResponse {
  messageId: string;
  provider: "ses" | "mailchannels" | "resend"; // managed outbound (SES暫定)
  acceptedAt: ISODateTime;
}
export interface MailMessage {
  id: string;
  messageId: string; // RFC Message-Id
  threadId: string;
  from: MailAddress;
  to: MailAddress[];
  subject: string;
  snippet: string;
  receivedAt: ISODateTime;
}
// Loop-prevention headers stamped on outbound + checked on inbound.
export interface MailLoopHeaders {
  "x-dub-mail-loop"?: string;
  "auto-submitted"?: string;
}
// Context passed to the inbound Email Routing Worker handler.
export interface InboundMailContext {
  from: string;
  to: string;
  messageId: string;
  rawSize: number;
  receivedAt: ISODateTime;
}

// ---- ③ inbox read-state + body (統合波 next slice; ADDITIVE — frozen ① untouched) ----
// The frozen `MailMessage` carries no read flag and no body (snippet only). Rather
// than mutate it, the inbox-detail slice layers read-state / body on as SUPERSETS:
// every type below `extends MailMessage`, so anything typed `MailMessage` still
// accepts them and existing consumers keep working. Populated from mail_inbound's
// added columns (read_at / body_text / html_body).

/** Per-message read state. read = (mail_inbound.read_at IS NOT NULL). */
export interface MailMessageState {
  read: boolean;
}
/** List/row view: the frozen message plus its read flag (drives the unread badge). */
export interface MailMessageListItem extends MailMessage, MailMessageState {}
/** Detail view: list item plus the full body. Inbound persists text; htmlBody is
 *  optional (present only when a message carried an HTML part) and MUST be sanitized
 *  before rendering. */
export interface MailMessageDetail extends MailMessageListItem {
  textBody: string;
  htmlBody?: string;
  // ADDITIVE (attachments slice): attachment metadata for this message. Omitted/[] when
  // the message carried none; each entry links to GET …/messages/:id/attachments/:attId.
  attachments?: MailAttachment[];
}
/** A thread = its id plus every message in receipt order (each a full detail). */
export interface MailThread {
  id: string;
  messages: MailMessageDetail[];
}

// ---- ④ Sent folder (統合波 next slice; ADDITIVE — frozen ① untouched) ----
// The idempotent send-log (二重送信ゼロ) is the source of truth for outbound mail.
// These read DTOs project a status='sent' send-log row into a Gmail-style "Sent"
// list/detail so the UI can show what was sent. Populated from mail_send_log's added
// columns (text_body / html_body / cc_json / snippet / from_address; migration 0004).

/** Sent-folder list row: one delivered outbound message (send-log status='sent'). */
export interface MailSentListItem {
  id: string;
  from?: MailAddress; // envelope From used for the send (when recorded)
  to: MailAddress[];
  cc?: MailAddress[];
  subject: string;
  snippet: string;
  sentAt: ISODateTime;
  provider: SendMailResponse["provider"];
  providerMessageId?: string;
  status: "sent";
  threadId?: string; // set for a reply (= parent message id); lets a client thread the reply into its conversation
}
/** Sent-folder detail: the list row plus the full body. htmlBody optional (present
 *  only when the send carried an HTML part) and MUST be sanitized before rendering. */
export interface MailSentDetail extends MailSentListItem {
  textBody: string;
  htmlBody?: string;
  // ADDITIVE (attachments slice): attachment metadata for this sent message. Omitted/[]
  // when none; each entry links to GET …/sent/:id/attachments/:attId.
  attachments?: MailAttachment[];
}

// ---- ⑤ per-user thread flags (改善#8; ADDITIVE — frozen ① untouched) ----
// Star / archive / trash persisted server-side, per user + per thread, so they survive a
// reload (previously in-memory only). A thread with no stored row is all-false (default).
/** One thread's flag state for the signed-in user. `purged` (完全に削除) is Gmail's
 *  "permanently delete from MY mailbox": a per-user, one-way view state (no restore) that
 *  hides the conversation from every folder for this viewer only — the row/body is NEVER
 *  physically deleted, so other accounts (and admins) still see it. */
export interface MailThreadFlags {
  threadId: string;
  starred: boolean;
  archived: boolean;
  trashed: boolean;
  purged: boolean;
}
/** Partial flag update (PATCH-style): only the provided flags change. */
export interface MailThreadFlagsPatch {
  starred?: boolean;
  archived?: boolean;
  trashed?: boolean;
  purged?: boolean;
}

// ---- ② STUB: 未決B(9-B)解決後に確定 ----
export interface Mailbox {
  address: string; // STUB
}
export interface MailWatch {
  id: string; // STUB
}
