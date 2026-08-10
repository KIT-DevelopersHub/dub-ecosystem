// Wire DTOs for the Gmail-parity操作系 surface. @dub/types `mail` is FROZEN (theme15),
// so these service-owned response shapes layer on as SUPERSETS: every message DTO here
// `extends` the frozen mail.* type, so anything the old endpoints returned still type-
// checks, and the fe2 Gmail-clone gets the extra flags/labels it needs in one payload.
// (Documented in the openapi contract; the frontend结線 reads these shapes.)
import type { mail } from "@dub/types";

/** A label definition (org-shared, like a Gmail label). */
export interface MailLabel {
  id: string;
  name: string;
  color: string | null; // hex "#RRGGBB" or null
}

/** Per-message Gmail-style flags derived from the nullable *_at stamps. */
export interface MailMessageFlags {
  starred: boolean;
  archived: boolean;
  trashed: boolean;
}

/** List row: frozen list item + flags + applied labels. */
export interface MailMessageListItemX extends mail.MailMessageListItem, MailMessageFlags {
  labels: MailLabel[];
}

/** Detail: frozen detail + flags + applied labels. */
export interface MailMessageDetailX extends mail.MailMessageDetail, MailMessageFlags {
  labels: MailLabel[];
}

/** Thread: frozen thread but each message is the enriched detail. */
export interface MailThreadX {
  id: string;
  messages: MailMessageDetailX[];
}

/** A saved compose draft. */
export interface MailDraft {
  id: string;
  to: mail.MailAddress[];
  cc?: mail.MailAddress[];
  subject: string;
  textBody: string;
  htmlBody?: string;
  inReplyTo?: string;
  threadId?: string;
  createdAt: string;
  updatedAt: string;
}

/** A sent-folder row (projected from the send-log; no body/from persisted there). */
export interface SentMailListItem {
  id: string;
  messageId: string;
  threadId: string | null;
  to: mail.MailAddress[];
  subject: string;
  provider: string | null;
  status: "pending" | "sent" | "failed";
  sentAt: string;
}

/** Folders backed by mail_inbound. sent/drafts have dedicated endpoints. */
export const INBOX_FOLDERS = ["inbox", "starred", "archived", "trash", "all"] as const;
export type InboxFolder = (typeof INBOX_FOLDERS)[number];
