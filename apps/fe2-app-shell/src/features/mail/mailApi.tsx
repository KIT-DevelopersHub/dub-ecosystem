// Mail feature api adapter (design 2-4). Like FE3–FE7's client adapters, mail rides
// the ONE shell api-client (src/lib/api-client.tsx): session cookie, 401→refresh,
// requestId, error normalization. Callers never write fetch and never paste a token
// — the browser session authorizes every call. Send targets the user-facing
// /api/v1/mail/outbox (mail:send); the raw internal /mail/send stays 404 externally.
import type { common, mail } from "@dub/types";
import type { ApiClient } from "../../lib/api-client.tsx";

type SendMailRequest = mail.SendMailRequest;
type SendMailResponse = mail.SendMailResponse;
type MailMessageListItem = mail.MailMessageListItem;
type MailMessageDetail = mail.MailMessageDetail;
type MailMessageState = mail.MailMessageState;
type MailThread = mail.MailThread;
type MailSentListItem = mail.MailSentListItem;
type MailSentDetail = mail.MailSentDetail;
type Paginated<T> = common.Paginated<T>;

export interface InboxQuery {
  limit?: number;
  cursor?: string;
  threadId?: string;
}

export interface SentQuery {
  limit?: number;
  cursor?: string;
}

export interface MailApi {
  /** Compose + send via the gateway (session-authorized, mail:send). */
  send(req: SendMailRequest): Promise<SendMailResponse>;
  /** List received messages with their read flag (mail:read). */
  listInbox(query?: InboxQuery): Promise<Paginated<MailMessageListItem>>;
  /** Fetch one message's full detail — body + read state (mail:read). */
  getMessage(id: string): Promise<MailMessageDetail>;
  /** Fetch a whole thread (every message, bodies included) (mail:read). */
  getThread(threadId: string): Promise<MailThread>;
  /** Mark a message read (idempotent). Returns the resulting read state (mail:read). */
  markRead(id: string): Promise<MailMessageState>;
  /** List sent messages, newest first (mail:read). */
  listSent(query?: SentQuery): Promise<Paginated<MailSentListItem>>;
  /** Fetch one sent message's full detail — body + recipients (mail:read). */
  getSent(id: string): Promise<MailSentDetail>;
  /** Download one attachment's bytes as a Blob (session-authorized; mail:read). */
  downloadAttachment(kind: "messages" | "sent", messageId: string, attId: string): Promise<Blob>;
  /** List the signed-in user's persisted thread flags (star/archive/trash) (mail:read). */
  listFlags(): Promise<mail.MailThreadFlags[]>;
  /** Persist a thread's flags (PATCH: only provided flags change). Returns the new state. */
  setFlags(threadId: string, patch: mail.MailThreadFlagsPatch): Promise<mail.MailThreadFlags>;
}

const MAIL = "/api/v1/mail";

/** Build the mail api from the shell ApiClient (fed in composition, faked in tests). */
export function createMailApi(api: ApiClient): MailApi {
  return {
    send: (req) => api.request<SendMailResponse, SendMailRequest>({ method: "POST", path: `${MAIL}/outbox`, body: req }),
    listInbox: (query) => {
      const q: Record<string, string | number | boolean | undefined> = {};
      if (query?.limit !== undefined) q.limit = query.limit;
      if (query?.cursor !== undefined) q.cursor = query.cursor;
      if (query?.threadId !== undefined) q.threadId = query.threadId;
      const hasQuery = Object.keys(q).length > 0;
      return api.request<Paginated<MailMessageListItem>>({ method: "GET", path: `${MAIL}/messages`, ...(hasQuery ? { query: q } : {}) });
    },
    getMessage: (id) => api.request<MailMessageDetail>({ method: "GET", path: `${MAIL}/messages/${encodeURIComponent(id)}` }),
    getThread: (threadId) => api.request<MailThread>({ method: "GET", path: `${MAIL}/threads/${encodeURIComponent(threadId)}` }),
    markRead: (id) => api.request<MailMessageState>({ method: "POST", path: `${MAIL}/messages/${encodeURIComponent(id)}/read` }),
    listSent: (query) => {
      const q: Record<string, string | number | boolean | undefined> = {};
      if (query?.limit !== undefined) q.limit = query.limit;
      if (query?.cursor !== undefined) q.cursor = query.cursor;
      const hasQuery = Object.keys(q).length > 0;
      return api.request<Paginated<MailSentListItem>>({ method: "GET", path: `${MAIL}/sent`, ...(hasQuery ? { query: q } : {}) });
    },
    getSent: (id) => api.request<MailSentDetail>({ method: "GET", path: `${MAIL}/sent/${encodeURIComponent(id)}` }),
    downloadAttachment: (kind, messageId, attId) => api.download(attachmentDownloadPath(kind, messageId, attId) as `/api/v1/${string}`),
    listFlags: () =>
      api
        .request<{ items: mail.MailThreadFlags[] }>({ method: "GET", path: `${MAIL}/flags` })
        .then((r) => r.items),
    setFlags: (threadId, patch) =>
      api.request<mail.MailThreadFlags, mail.MailThreadFlagsPatch>({ method: "POST", path: `${MAIL}/flags/${encodeURIComponent(threadId)}`, body: patch }),
  };
}

// ---- compose form helpers (pure; unit-tested) ----

/** Parse a comma / newline / semicolon separated recipient string into MailAddress[].
 *  `Name <a@b.com>` and bare `a@b.com` are both accepted. Invalid tokens are dropped
 *  from the result and returned separately so the form can flag them. */
export function parseRecipients(raw: string): { recipients: mail.MailAddress[]; invalid: string[] } {
  const tokens = raw
    .split(/[,;\n]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const recipients: mail.MailAddress[] = [];
  const invalid: string[] = [];
  for (const tok of tokens) {
    const named = /^(.*?)<([^>]+)>$/.exec(tok);
    const name = named ? named[1]!.trim() : "";
    const email = (named ? named[2]! : tok).trim();
    if (isValidEmail(email)) recipients.push(name ? { email, name } : { email });
    else invalid.push(tok);
  }
  return { recipients, invalid };
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

// ---- attachments (attachments slice) ----
/** Per-file ceiling mirrored from the gateway (MAX_ATTACHMENT_BYTES). */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Per-message total ceiling mirrored from the gateway (MAX_ATTACHMENTS_TOTAL_BYTES). */
export const MAX_ATTACHMENTS_TOTAL_BYTES = 25 * 1024 * 1024;
/** Max attachment count mirrored from the gateway (MAX_ATTACHMENTS_PER_MESSAGE). */
export const MAX_ATTACHMENTS = 10;

/** Standard base64 of an ArrayBuffer (chunked so a large file never blows the call stack). */
function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Read a browser File into the gateway's MailAttachmentInput (base64 body). */
export async function fileToAttachment(file: File): Promise<mail.MailAttachmentInput> {
  const buf = await file.arrayBuffer();
  return {
    filename: file.name,
    contentType: file.type || "application/octet-stream",
    contentBase64: bufferToBase64(buf),
  };
}

/** Same-origin download path for a stored attachment (the gateway streams the R2 body with
 *  a download disposition). Used by the MailApi download call (session-authorized fetch). */
export function attachmentDownloadPath(kind: "messages" | "sent", messageId: string, attId: string): string {
  return `${MAIL}/${kind}/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attId)}`;
}

/** Trigger a browser "Save as" for an in-memory Blob (from downloadAttachment). */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click's navigation has grabbed the URL first.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Human-readable byte size (KB/MB) for the attachment chips. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
