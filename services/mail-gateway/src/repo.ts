// D1 access for the mail_ namespace. Uses @dub/db DbClient (namespace-scoped,
// runtime-DDL-forbidden). Every SQL statement touches mail_* tables only.
import { type DbClient, newId, nowIso } from "@dub/db";
import { errors } from "@dub/errors";
import type { common, mail } from "@dub/types";

// ---- row shapes ----
export interface SendLogRow {
  id: string;
  idempotency_key: string;
  req_hash: string;
  requester: string;
  to_json: string;
  subject: string;
  thread_id: string | null;
  provider: string | null;
  provider_message_id: string | null;
  status: "pending" | "sent" | "failed";
  error_code: string | null;
  created_at: string;
  updated_at: string;
  text_body: string | null; // 0004: plain-text body as submitted (Sent detail)
  html_body: string | null; // 0004: HTML part when present (sanitized before render)
  cc_json: string | null; // 0004: JSON MailAddress[] of Cc recipients
  snippet: string | null; // 0004: first ~140 chars of text_body (Sent list preview)
  from_address: string | null; // 0004: envelope From used for the send
}

export interface InboundRow {
  id: string;
  message_id: string;
  thread_id: string;
  mailbox: string | null;
  from_json: string;
  to_json: string;
  subject: string;
  snippet: string;
  auto_submitted: string | null;
  loop_marker: string | null;
  received_at: string;
  created_at: string;
  body_text: string | null; // 0002: full plain-text body (detail view)
  html_body: string | null; // 0002: HTML part when present (sanitized before render)
  read_at: string | null; // 0002: ISO8601 when first opened; NULL = unread
}

export interface MailboxRow {
  id: string;
  address: string;
  provider: string;
  created_at: string;
  updated_at: string;
}

// ---- opaque cursor codec (base64url of the row id; D3) ----
export function encodeCursor(id: string): string {
  return btoa(id).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decodeCursor(cursor: string): string {
  try {
    return atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    throw errors.validationFailed([{ field: "cursor", reason: "invalid_cursor" }]);
  }
}

// ---- outbound send log ----
export async function findSendByKey(db: DbClient, idempotencyKey: string): Promise<SendLogRow | null> {
  return db.first<SendLogRow>(`SELECT * FROM mail_send_log WHERE idempotency_key = ?`, idempotencyKey);
}

/** First ~140 chars of the body on a single line — the Sent-list preview text. */
export function snippetOf(textBody: string, max = 140): string {
  const oneLine = textBody.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) : oneLine;
}

/** Claim a send: INSERT OR IGNORE on the UNIQUE idempotency_key. changes===0 means a
 *  concurrent/prior claim won the race (the caller then re-reads and dedups). The body
 *  columns (text/html/cc/snippet/from — migration 0004) are persisted at claim time so
 *  a later status='sent' row can back the Sent folder. The idempotency contract is
 *  unchanged: still one INSERT OR IGNORE on UNIQUE(idempotency_key), added columns only. */
export async function insertSendClaim(
  db: DbClient,
  row: {
    id: string;
    idempotencyKey: string;
    reqHash: string;
    requester: string;
    toJson: string;
    subject: string;
    threadId: string | null;
    textBody: string;
    htmlBody: string | null;
    ccJson: string;
    fromAddress: string;
  },
): Promise<number> {
  const now = nowIso();
  const res = await db.run(
    `INSERT OR IGNORE INTO mail_send_log
       (id, idempotency_key, req_hash, requester, to_json, subject, thread_id,
        provider, provider_message_id, status, error_code, created_at, updated_at,
        text_body, html_body, cc_json, snippet, from_address)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'pending', NULL, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.idempotencyKey,
    row.reqHash,
    row.requester,
    row.toJson,
    row.subject,
    row.threadId,
    now,
    now,
    row.textBody,
    row.htmlBody,
    row.ccJson,
    snippetOf(row.textBody),
    row.fromAddress,
  );
  return res.meta.changes;
}

export async function markSendSent(db: DbClient, id: string, provider: string, providerMessageId: string): Promise<void> {
  await db.run(
    `UPDATE mail_send_log SET status = 'sent', provider = ?, provider_message_id = ?, error_code = NULL, updated_at = ?
     WHERE id = ?`,
    provider,
    providerMessageId,
    nowIso(),
    id,
  );
}

/** Most recent FAILED send (error_code + updated_at only) — backs the rate-limit status
 *  view. Uses idx_mail_send_log_status(status, updated_at) for an index-ordered read. */
export async function latestFailedSend(db: DbClient): Promise<{ error_code: string | null; updated_at: string } | null> {
  return db.first<{ error_code: string | null; updated_at: string }>(
    `SELECT error_code, updated_at FROM mail_send_log WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 1`,
  );
}

export async function markSendFailed(db: DbClient, id: string, errorCode: string): Promise<void> {
  await db.run(
    `UPDATE mail_send_log SET status = 'failed', error_code = ?, updated_at = ? WHERE id = ?`,
    errorCode,
    nowIso(),
    id,
  );
}

// ---- sent folder (projects status='sent' send-log rows into read DTOs) ----
function parseAddresses(json: string | null): mail.MailAddress[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as mail.MailAddress[]) : [];
  } catch {
    return [];
  }
}

function sendRowToListItem(r: SendLogRow): mail.MailSentListItem {
  const item: mail.MailSentListItem = {
    id: r.id,
    to: parseAddresses(r.to_json),
    subject: r.subject,
    snippet: r.snippet ?? "",
    sentAt: r.updated_at, // when the row flipped to 'sent'
    provider: (r.provider as mail.SendMailResponse["provider"]) ?? "ses",
    status: "sent",
  };
  const cc = parseAddresses(r.cc_json);
  if (cc.length > 0) item.cc = cc;
  if (r.from_address) item.from = { email: r.from_address };
  if (r.provider_message_id) item.providerMessageId = r.provider_message_id;
  // thread_id is set for replies (= the parent message's id). Surfacing it lets the
  // client fold a sent reply back into its conversation instead of showing it as a
  // detached Sent thread (so the reply stays visible in the open thread).
  if (r.thread_id) item.threadId = r.thread_id;
  return item;
}

function sendRowToDetail(r: SendLogRow): mail.MailSentDetail {
  const detail: mail.MailSentDetail = { ...sendRowToListItem(r), textBody: r.text_body ?? "" };
  if (r.html_body !== null && r.html_body !== "") detail.htmlBody = r.html_body;
  return detail;
}

/** List sent mail (status='sent'), newest first. id-based opaque cursor (like
 *  listInbound); ULID ids sort in creation order so the id cursor tracks created_at. */
export async function listSent(
  db: DbClient,
  q: { cursor?: string; limit: number },
): Promise<common.Paginated<mail.MailSentListItem>> {
  const where: string[] = ["status = 'sent'"];
  const binds: unknown[] = [];
  if (q.cursor !== undefined) {
    where.push("id < ?");
    binds.push(decodeCursor(q.cursor));
  }
  const rows = await db.all<SendLogRow>(
    `SELECT * FROM mail_send_log WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ...binds,
    q.limit + 1,
  );
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(sendRowToListItem),
    nextCursor: hasMore && last ? encodeCursor(last.id) : null,
  };
}

/** Full sent detail (body included) — backs GET /sent/:id. Only a delivered
 *  (status='sent') row is returned; a pending/failed row reads as not-found. */
export async function getSentDetail(db: DbClient, id: string): Promise<mail.MailSentDetail | null> {
  const row = await db.first<SendLogRow>(`SELECT * FROM mail_send_log WHERE id = ? AND status = 'sent'`, id);
  return row ? sendRowToDetail(row) : null;
}

// ---- inbound ----
export async function seenInbound(db: DbClient, messageId: string): Promise<boolean> {
  const row = await db.first<{ message_id: string }>(`SELECT message_id FROM mail_inbound WHERE message_id = ?`, messageId);
  return row !== null;
}

/** The received message with this RFC Message-Id, if any. Backs reply-From resolution:
 *  a reply's inReplyTo points at the parent inbound message, whose recipient mailbox
 *  (the address the conversation was addressed to, e.g. info@) is the identity the reply
 *  should go out as. Returns the raw row so callers can read to_json / mailbox. */
export async function findInboundByMessageId(db: DbClient, messageId: string): Promise<InboundRow | null> {
  return db.first<InboundRow>(`SELECT * FROM mail_inbound WHERE message_id = ?`, messageId);
}

/** Persist a normalized inbound message. INSERT OR IGNORE on message_id makes an
 *  Email-Routing redelivery a no-op; returns changes (0 = duplicate). */
export async function insertInbound(
  db: DbClient,
  m: mail.MailMessage,
  extra: { mailbox: string | null; autoSubmitted: string | null; loopMarker: string | null; bodyText: string; htmlBody: string | null },
): Promise<number> {
  const res = await db.run(
    `INSERT OR IGNORE INTO mail_inbound
       (id, message_id, thread_id, mailbox, from_json, to_json, subject, snippet,
        auto_submitted, loop_marker, received_at, created_at, body_text, html_body, read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    m.id,
    m.messageId,
    m.threadId,
    extra.mailbox,
    JSON.stringify(m.from),
    JSON.stringify(m.to),
    m.subject,
    m.snippet,
    extra.autoSubmitted,
    extra.loopMarker,
    m.receivedAt,
    nowIso(),
    extra.bodyText,
    extra.htmlBody,
  );
  return res.meta.changes;
}

function rowToMailMessage(r: InboundRow): mail.MailMessage {
  return {
    id: r.id,
    messageId: r.message_id,
    threadId: r.thread_id,
    from: JSON.parse(r.from_json) as mail.MailAddress,
    to: JSON.parse(r.to_json) as mail.MailAddress[],
    subject: r.subject,
    snippet: r.snippet,
    receivedAt: r.received_at,
  };
}

/** List item = frozen message + read flag (read := read_at IS NOT NULL). */
function rowToListItem(r: InboundRow): mail.MailMessageListItem {
  return { ...rowToMailMessage(r), read: r.read_at !== null };
}

/** Detail = list item + full body. htmlBody omitted (not set) when the row has none. */
function rowToDetail(r: InboundRow): mail.MailMessageDetail {
  const detail: mail.MailMessageDetail = { ...rowToListItem(r), textBody: r.body_text ?? "" };
  if (r.html_body !== null && r.html_body !== "") detail.htmlBody = r.html_body;
  return detail;
}

/** Frozen-message read (kept for callers that only need the base DTO). */
export async function getInboundById(db: DbClient, id: string): Promise<mail.MailMessage | null> {
  const row = await db.first<InboundRow>(`SELECT * FROM mail_inbound WHERE id = ?`, id);
  return row ? rowToMailMessage(row) : null;
}

/** Full detail (body + read state) — backs GET /messages/:id. */
export async function getInboundDetail(db: DbClient, id: string): Promise<mail.MailMessageDetail | null> {
  const row = await db.first<InboundRow>(`SELECT * FROM mail_inbound WHERE id = ?`, id);
  return row ? rowToDetail(row) : null;
}

/** Every message in a thread, oldest→newest, as full details — backs GET /threads/:id. */
export async function listThread(db: DbClient, threadId: string): Promise<mail.MailMessageDetail[]> {
  const rows = await db.all<InboundRow>(
    `SELECT * FROM mail_inbound WHERE thread_id = ? ORDER BY received_at ASC, id ASC`,
    threadId,
  );
  return rows.map(rowToDetail);
}

/** Mark a message read (idempotent): stamps read_at only on the first open. Returns
 *  whether the message exists so the route can 404 an unknown id. */
export async function markInboundRead(db: DbClient, id: string): Promise<{ found: boolean }> {
  const row = await db.first<{ id: string }>(`SELECT id FROM mail_inbound WHERE id = ?`, id);
  if (!row) return { found: false };
  await db.run(`UPDATE mail_inbound SET read_at = ? WHERE id = ? AND read_at IS NULL`, nowIso(), id);
  return { found: true };
}

export async function listInbound(
  db: DbClient,
  q: { threadId?: string; cursor?: string; limit: number },
): Promise<common.Paginated<mail.MailMessageListItem>> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (q.threadId !== undefined) {
    where.push("thread_id = ?");
    binds.push(q.threadId);
  }
  if (q.cursor !== undefined) {
    where.push("id < ?");
    binds.push(decodeCursor(q.cursor));
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await db.all<InboundRow>(
    `SELECT * FROM mail_inbound ${whereSql} ORDER BY id DESC LIMIT ?`,
    ...binds,
    q.limit + 1,
  );
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(rowToListItem),
    nextCursor: hasMore && last ? encodeCursor(last.id) : null,
  };
}

// ---- mailboxes ----
export async function listMailboxes(db: DbClient): Promise<mail.Mailbox[]> {
  const rows = await db.all<MailboxRow>(`SELECT * FROM mail_mailboxes ORDER BY id ASC`);
  return rows.map((r) => ({ address: r.address }));
}

export async function upsertMailbox(db: DbClient, id: string, address: string): Promise<void> {
  const now = nowIso();
  const upd = await db.run(`UPDATE mail_mailboxes SET address = ?, updated_at = ? WHERE id = ?`, address, now, id);
  if (upd.meta.changes === 0) {
    await db.run(
      `INSERT OR IGNORE INTO mail_mailboxes (id, address, provider, created_at, updated_at)
       VALUES (?, ?, 'cf-email-routing', ?, ?)`,
      id,
      address,
      now,
      now,
    );
  }
}

// ---- retention purge (scheduled) ----
export async function purgeOlderThan(db: DbClient, sendCutoff: string, inboundCutoff: string): Promise<{ sendLog: number; inbound: number }> {
  const sendLog = (await db.run(`DELETE FROM mail_send_log WHERE created_at < ?`, sendCutoff)).meta.changes;
  const inbound = (await db.run(`DELETE FROM mail_inbound WHERE created_at < ?`, inboundCutoff)).meta.changes;
  return { sendLog, inbound };
}

// ---- id mints ----
export const newSendLogId = (): string => newId("maillog");
export const newInboundId = (): string => newId("mailin");
