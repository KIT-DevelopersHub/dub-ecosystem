// D1 access for the mail_ namespace. Uses @dub/db DbClient (namespace-scoped,
// runtime-DDL-forbidden). Every SQL statement touches mail_* tables only.
import { type DbClient, newId, nowIso } from "@dub/db";
import { errors } from "@dub/errors";
import type { common, mail } from "@dub/types";
import type { InboxFolder, MailLabel, MailMessageDetailX, MailMessageListItemX } from "./ops-dto";

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
  starred_at: string | null; // 0003: ISO8601 when starred; NULL = not starred
  archived_at: string | null; // 0003: ISO8601 when archived (out of Inbox); NULL = in Inbox
  trashed_at: string | null; // 0003: ISO8601 when trashed; NULL = not in Trash
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

/** Claim a send: INSERT OR IGNORE on the UNIQUE idempotency_key. changes===0 means a
 *  concurrent/prior claim won the race (the caller then re-reads and dedups). */
export async function insertSendClaim(
  db: DbClient,
  row: { id: string; idempotencyKey: string; reqHash: string; requester: string; toJson: string; subject: string; threadId: string | null },
): Promise<number> {
  const now = nowIso();
  const res = await db.run(
    `INSERT OR IGNORE INTO mail_send_log
       (id, idempotency_key, req_hash, requester, to_json, subject, thread_id,
        provider, provider_message_id, status, error_code, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'pending', NULL, ?, ?)`,
    row.id,
    row.idempotencyKey,
    row.reqHash,
    row.requester,
    row.toJson,
    row.subject,
    row.threadId,
    now,
    now,
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

// ---- inbound ----
export async function seenInbound(db: DbClient, messageId: string): Promise<boolean> {
  const row = await db.first<{ message_id: string }>(`SELECT message_id FROM mail_inbound WHERE message_id = ?`, messageId);
  return row !== null;
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

/** Gmail-style flags derived from the nullable *_at stamps (0003). */
function rowFlags(r: InboundRow): { starred: boolean; archived: boolean; trashed: boolean } {
  return { starred: r.starred_at !== null, archived: r.archived_at !== null, trashed: r.trashed_at !== null };
}

/** List item = frozen message + read flag (read := read_at IS NOT NULL) + flags + labels. */
function rowToListItem(r: InboundRow, labels: MailLabel[] = []): MailMessageListItemX {
  return { ...rowToMailMessage(r), read: r.read_at !== null, ...rowFlags(r), labels };
}

/** Detail = list item + full body. htmlBody omitted (not set) when the row has none. */
function rowToDetail(r: InboundRow, labels: MailLabel[] = []): MailMessageDetailX {
  const detail: MailMessageDetailX = { ...rowToListItem(r, labels), textBody: r.body_text ?? "" };
  if (r.html_body !== null && r.html_body !== "") detail.htmlBody = r.html_body;
  return detail;
}

/** Fetch every applied label for a set of message ids → Map(messageId → labels[]).
 *  Read-side enrichment helper (lives here, next to the row mappers it feeds, so the
 *  write-side ops-repo never imports back into this list path). */
export async function labelsForMessages(db: DbClient, ids: string[]): Promise<Map<string, MailLabel[]>> {
  const out = new Map<string, MailLabel[]>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => "?").join(", ");
  const rows = await db.all<{ message_id: string; id: string; name: string; color: string | null }>(
    `SELECT ml.message_id AS message_id, l.id AS id, l.name AS name, l.color AS color
       FROM mail_message_labels ml
       JOIN mail_labels l ON l.id = ml.label_id
      WHERE ml.message_id IN (${placeholders})
      ORDER BY l.name ASC`,
    ...ids,
  );
  for (const r of rows) {
    const list = out.get(r.message_id) ?? [];
    list.push({ id: r.id, name: r.name, color: r.color });
    out.set(r.message_id, list);
  }
  return out;
}

/** Frozen-message read (kept for callers that only need the base DTO). */
export async function getInboundById(db: DbClient, id: string): Promise<mail.MailMessage | null> {
  const row = await db.first<InboundRow>(`SELECT * FROM mail_inbound WHERE id = ?`, id);
  return row ? rowToMailMessage(row) : null;
}

/** Full detail (body + read state + flags + labels) — backs GET /messages/:id. */
export async function getInboundDetail(db: DbClient, id: string): Promise<MailMessageDetailX | null> {
  const row = await db.first<InboundRow>(`SELECT * FROM mail_inbound WHERE id = ?`, id);
  if (!row) return null;
  const labels = (await labelsForMessages(db, [id])).get(id) ?? [];
  return rowToDetail(row, labels);
}

/** Every message in a thread, oldest→newest, as full details — backs GET /threads/:id. */
export async function listThread(db: DbClient, threadId: string): Promise<MailMessageDetailX[]> {
  const rows = await db.all<InboundRow>(
    `SELECT * FROM mail_inbound WHERE thread_id = ? ORDER BY received_at ASC, id ASC`,
    threadId,
  );
  const byMsg = await labelsForMessages(db, rows.map((r) => r.id));
  return rows.map((r) => rowToDetail(r, byMsg.get(r.id) ?? []));
}

/** Mark a message read (idempotent): stamps read_at only on the first open. Returns
 *  whether the message exists so the route can 404 an unknown id. */
export async function markInboundRead(db: DbClient, id: string): Promise<{ found: boolean }> {
  const row = await db.first<{ id: string }>(`SELECT id FROM mail_inbound WHERE id = ?`, id);
  if (!row) return { found: false };
  await db.run(`UPDATE mail_inbound SET read_at = ? WHERE id = ? AND read_at IS NULL`, nowIso(), id);
  return { found: true };
}

/** Translate a Gmail-style folder into a mail_inbound WHERE fragment (flags-based). */
function folderWhere(folder: InboxFolder): string {
  switch (folder) {
    case "starred":
      return "starred_at IS NOT NULL AND trashed_at IS NULL";
    case "archived":
      return "archived_at IS NOT NULL AND trashed_at IS NULL";
    case "trash":
      return "trashed_at IS NOT NULL";
    case "all":
      return "trashed_at IS NULL";
    case "inbox":
    default:
      return "trashed_at IS NULL AND archived_at IS NULL";
  }
}

export interface ListMessagesQuery {
  threadId?: string;
  cursor?: string;
  limit: number;
  folder?: InboxFolder; // default "inbox"
  q?: string; // free-text search (optional from:/subject: prefixes)
  label?: string; // only messages carrying this label id
}

export async function listInbound(db: DbClient, q: ListMessagesQuery): Promise<common.Paginated<MailMessageListItemX>> {
  const where: string[] = [folderWhere(q.folder ?? "inbox")];
  const binds: unknown[] = [];
  if (q.threadId !== undefined) {
    where.push("thread_id = ?");
    binds.push(q.threadId);
  }
  if (q.label !== undefined) {
    where.push("id IN (SELECT message_id FROM mail_message_labels WHERE label_id = ?)");
    binds.push(q.label);
  }
  if (q.q !== undefined && q.q !== "") {
    const { field, term } = parseSearch(q.q);
    const like = `%${term}%`;
    if (field === "from") {
      where.push("from_json LIKE ?");
      binds.push(like);
    } else if (field === "subject") {
      where.push("subject LIKE ?");
      binds.push(like);
    } else {
      where.push("(subject LIKE ? OR snippet LIKE ? OR body_text LIKE ? OR from_json LIKE ?)");
      binds.push(like, like, like, like);
    }
  }
  if (q.cursor !== undefined) {
    where.push("id < ?");
    binds.push(decodeCursor(q.cursor));
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const rows = await db.all<InboundRow>(
    `SELECT * FROM mail_inbound ${whereSql} ORDER BY id DESC LIMIT ?`,
    ...binds,
    q.limit + 1,
  );
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page[page.length - 1];
  const byMsg = await labelsForMessages(db, page.map((r) => r.id));
  return {
    items: page.map((r) => rowToListItem(r, byMsg.get(r.id) ?? [])),
    nextCursor: hasMore && last ? encodeCursor(last.id) : null,
  };
}

/** Minimal search grammar: a leading `from:` / `subject:` operator scopes the term;
 *  otherwise the term matches across subject/snippet/body/from. */
function parseSearch(raw: string): { field: "from" | "subject" | "any"; term: string } {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("from:")) return { field: "from", term: trimmed.slice(5).trim() };
  if (lower.startsWith("subject:")) return { field: "subject", term: trimmed.slice(8).trim() };
  return { field: "any", term: trimmed };
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
