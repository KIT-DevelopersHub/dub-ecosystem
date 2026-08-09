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

// ---- ② STUB: 未決B(9-B)解決後に確定 ----
export interface Mailbox {
  address: string; // STUB
}
export interface MailWatch {
  id: string; // STUB
}
