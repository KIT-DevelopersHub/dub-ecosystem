// mail — mail-gateway namespace. 2-stage (theme15 decision5):
//   ① reference types (SendMail*, MailMessage, loop headers, inbound ctx): frozen.
//   ② Mailbox/Watch types: STUB pending 9-B.
// Mail policy (判断46/50): inbound = Cloudflare Email Routing -> Worker (self-built
// app); outbound = managed provider (SES暫定). Header stubs only in foundation.
import type { ISODateTime, CursorQuery } from "./common";

// ---- query contract (GET /messages, GET /sent — same shape) ----
export interface ListMailMessagesQuery extends CursorQuery {
  threadId?: string;
  // ADDITIVE (server-side search): free-text, case-insensitive (ASCII) substring match over
  // subject / snippet / body / From / To / Cc (Sent: subject / snippet / body / To / Cc).
  // Trimmed; blank = no search; max 200 chars. Narrows within the caller's account scope
  // only (never widens visibility). Combines with cursor/limit for paging the results.
  q?: string;
  // ADDITIVE (folder views): page by CONVERSATION for one mailbox view, with every filter
  // (blocked senders, the viewer's archive/trash/star/purge flags, mine/others) applied in
  // SQL BEFORE the limit, so each page holds exactly `limit` conversations (last page
  // excepted). The response then carries `total` (conversations in the view). Absent = the
  // legacy message-level list (no folder filtering), kept for older clients.
  folder?: MailFolderView;
}

/** Server-side mailbox views for GET /mail/messages?folder=. `all` = every view except
 *  Trash and ブロック済み (the search scope). */
export type MailFolderView = "inbox" | "mine" | "others" | "starred" | "archive" | "trash" | "blocked" | "all";
export const MAIL_FOLDER_VIEWS: readonly MailFolderView[] = ["inbox", "mine", "others", "starred", "archive", "trash", "blocked", "all"];

/** GET /mail/messages?folder= response: a conversation page. `items` are the in-scope
 *  messages of the page's conversations; `total` counts conversations in the whole view. */
export interface MailMessagePage {
  items: MailMessageListItem[];
  nextCursor: string | null;
  total?: number;
}

/** GET /mail/counts: conversations per view, and how many have unread mail for the viewer
 *  (ブロック済み never counts as unread). */
export interface MailFolderCount {
  total: number;
  unread: number;
}
export type MailFolderCounts = Record<Exclude<MailFolderView, "all">, MailFolderCount>;

// ── Wire contract (query params) ─────────────────────────────────────────────
// SINGLE source of truth for the query-parameter *names* mail-gateway's messages list
// endpoint puts on the wire. The server (mail-gateway validation.ts parseListMessagesQuery)
// and the OpenAPI spec (docs/openapi/mail-gateway.yaml) are reconciled against this map in
// CI (see @dub/e2e-smoke wire-params.test.ts). The Sent-folder GET (/sent) uses the SAME
// parser, so its cursor/limit/threadId keys are covered by this same entry (it is not
// separately spec'd — documenting it is a noted follow-up). See
// docs/api-contracts/_wire-contract-enforcement.md.
export const MAIL_WIRE = {
  listMailMessages: { method: "GET", path: "/messages", query: ["cursor", "folder", "limit", "q", "threadId"] },
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
  // ADDITIVE (Bcc): envelope-only recipients. Delivered by the provider as real Bcc, never
  // written to any header; stored on the send log and shown in Sent to the sender only.
  // Same validation/limits as cc. Also persisted on a scheduled send (mail_scheduled.bcc_json).
  bcc?: MailAddress[];
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
export interface MailMessageListItem extends MailMessage, MailMessageState {
  // ADDITIVE: true when the message is delivered to the caller's own account; false when it
  // is visible only through oversight (mail:read_all) or role sharing (mail:read_role_shared).
  // Absent from older gateways — treat absent as true.
  mine?: boolean;
  // ADDITIVE: Cc recipients of a received message (mail_inbound.cc_json, 0012). Omitted when
  // the message had none or was stored before 0012.
  cc?: MailAddress[];
  // ADDITIVE: true when the sender matches the VIEWER's own block list (mail_sender_blocks,
  // 0021). Derived per request, never stored on the message, so unblocking restores it.
  // Clients keep blocked mail out of the inbox / unread counts (ブロック済み view only).
  // Absent from older gateways — treat absent as false.
  blocked?: boolean;
}
/** Detail view: list item plus the full body. Inbound persists text; htmlBody is
 *  optional (present only when a message carried an HTML part) and MUST be sanitized
 *  before rendering. */
/** Delivery details of a received message, read from its headers at ingest (Gmail's
 *  "show details" dialog). Every field is best-effort: absent = the header was missing
 *  or the row was stored before 0013. */
export interface MailHeaderMeta {
  replyTo?: MailAddress[]; // Reply-To header
  deliveredTo?: string; // envelope recipient = the address this copy reached (the owner's own)
  mailedBy?: string; // envelope sender (MAIL FROM) domain
  signedBy?: string; // DKIM signing domain that passed (Cloudflare's ARC-Authentication-Results)
  tls?: boolean; // whether the hop into Cloudflare used TLS; absent = unknown
}
export interface MailMessageDetail extends MailMessageListItem {
  textBody: string;
  htmlBody?: string;
  // ADDITIVE (0013): delivery details for the "show details" dialog. Omitted when unknown.
  headerMeta?: MailHeaderMeta;
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
  bcc?: MailAddress[]; // ADDITIVE: present only for the sender's own view (never read_all)
  subject: string;
  snippet: string;
  sentAt: ISODateTime;
  provider: SendMailResponse["provider"];
  providerMessageId?: string;
  status: "sent";
  threadId?: string; // set for a reply (= parent message id); lets a client thread the reply into its conversation
  // ADDITIVE: false when this row is another account's send, visible only via oversight
  // (mail:read_all). Absent/true = the viewer sent it. Lets a client keep someone else's
  // From out of "my addresses" (自分 labelling, reply-all exclusion, reply addressing).
  mine?: boolean;
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

// ---- ⑤ Scheduled send (予約送信 / 予約投稿; ADDITIVE — frozen ① untouched) ----
// A compose the sender parked to go out at a future time (Gmail's "送信日時を設定"). The
// full payload is stored in mail_scheduled with status='scheduled' and a due time; a
// free-tier drain claims due rows and hands each to the SAME send core as an immediate
// send (so 二重送信ゼロ / Sent-folder / archive-CC all hold). List / edit / cancel act on
// still-'scheduled' rows only. Attachments + Bcc ride along (ADDITIVE, migration 0020):
// the bytes are parked in R2 and re-attached by the drain at delivery time.

/** Terminal + live states of a scheduled send. */
export type ScheduledSendStatus = "scheduled" | "sent" | "canceled" | "failed";

/** POST /mail/scheduled body: a SendMailRequest plus the future send time. */
export interface ScheduleMailRequest extends SendMailRequest {
  /** ISO8601 time to send. Must be in the future (server rejects a past time). */
  scheduledAt: ISODateTime;
}
/** Accepted-schedule ack (POST /mail/scheduled). */
export interface ScheduleMailResponse {
  id: string;
  scheduledAt: ISODateTime;
  status: "scheduled";
}
/** Scheduled-folder list row (body omitted; snippet only, like the Sent list). */
export interface ScheduledSendListItem {
  id: string;
  from?: MailAddress; // resolved envelope From when already known (else at send time)
  to: MailAddress[];
  cc?: MailAddress[];
  subject: string;
  snippet: string;
  scheduledAt: ISODateTime;
  createdAt: ISODateTime;
  status: ScheduledSendStatus;
  inReplyTo?: string; // set when the scheduled send is a reply
  sentMessageId?: string; // set once delivered (status='sent')
  errorCode?: string; // set when the drain gave up (status='failed')
  // ADDITIVE (0020): metadata of the files parked with the schedule (bytes in R2). Absent
  // when none, so an attachment-less row is byte-identical to the 0010 shape.
  attachments?: MailAttachment[];
}
/** Scheduled-folder detail: list row plus the full editable body. */
export interface ScheduledSendDetail extends ScheduledSendListItem {
  textBody: string;
  htmlBody?: string;
  bcc?: MailAddress[]; // ADDITIVE (0020): envelope-only Bcc, shown to the owner only
}
/** PATCH /mail/scheduled/:id — edit fields and/or reschedule. All optional; only the
 *  provided fields change. Allowed only while the row is still 'scheduled'. */
export interface ScheduleMailPatch {
  to?: MailAddress[];
  cc?: MailAddress[];
  subject?: string;
  textBody?: string;
  htmlBody?: string;
  scheduledAt?: ISODateTime;
}

// ---- ⑥ per-user thread flags (改善#8; ADDITIVE — frozen ① untouched) ----
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
  /** 返信不要: when the user dismissed the reply nudge (ISO), null = not dismissed. Covers only
   *  mail received up to this moment — a newer received message brings the nudge back.
   *  ADDITIVE: an older gateway omits it (clients treat absent as null). */
  noReplyAt: ISODateTime | null;
}
/** Partial flag update (PATCH-style): only the provided flags change. */
export interface MailThreadFlagsPatch {
  starred?: boolean;
  archived?: boolean;
  trashed?: boolean;
  purged?: boolean;
  /** true = dismiss the reply nudge now (server stamps noReplyAt = now, every press);
   *  false = clear it (undo). Absent = leave noReplyAt unchanged. */
  noReply?: boolean;
}

// ---- sender block list (この送信者をブロック, 0021) ----
// Personal (per mailbox owner) list of blocked sender addresses / whole domains. Blocking
// never deletes mail: blocked messages stay stored and are only flagged `blocked` on read.
export type MailSenderBlockKind = "address" | "domain";
/** One entry of the signed-in user's block list. `value` is lowercased: a full address for
 *  kind "address", a bare domain ("example.com") for kind "domain". */
export interface MailSenderBlock {
  value: string;
  kind: MailSenderBlockKind;
  createdAt: ISODateTime;
}
/** POST /mail/blocks body. `kind` defaults from the value ("@" present -> address). */
export interface MailSenderBlockRequest {
  value: string;
  kind?: MailSenderBlockKind;
}
/** Per-user cap on block-list entries (the API answers 409 beyond it). */
export const MAIL_SENDER_BLOCK_LIMIT = 500;

// ---- ② STUB: 未決B(9-B)解決後に確定 ----
export interface Mailbox {
  address: string; // STUB
}
export interface MailWatch {
  id: string; // STUB
}
