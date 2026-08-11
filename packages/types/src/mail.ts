// mail — mail-gateway namespace. 2-stage (theme15 decision5):
//   ① reference types (SendMail*, MailMessage, loop headers, inbound ctx): frozen.
//   ② Mailbox/Watch types: STUB pending 9-B.
// Mail policy (判断46/50): inbound = Cloudflare Email Routing -> Worker (self-built
// app); outbound = managed provider (SES暫定). Header stubs only in foundation.
import type { ISODateTime } from "./common";

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
}
/** Sent-folder detail: the list row plus the full body. htmlBody optional (present
 *  only when the send carried an HTML part) and MUST be sanitized before rendering. */
export interface MailSentDetail extends MailSentListItem {
  textBody: string;
  htmlBody?: string;
}

// ---- ② STUB: 未決B(9-B)解決後に確定 ----
export interface Mailbox {
  address: string; // STUB
}
export interface MailWatch {
  id: string; // STUB
}
