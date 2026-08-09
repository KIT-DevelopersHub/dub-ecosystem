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
export async function insertInbound(db: DbClient, m: mail.MailMessage, extra: { mailbox: string | null; autoSubmitted: string | null; loopMarker: string | null }): Promise<number> {
  const res = await db.run(
    `INSERT OR IGNORE INTO mail_inbound
       (id, message_id, thread_id, mailbox, from_json, to_json, subject, snippet,
        auto_submitted, loop_marker, received_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

export async function getInboundById(db: DbClient, id: string): Promise<mail.MailMessage | null> {
  const row = await db.first<InboundRow>(`SELECT * FROM mail_inbound WHERE id = ?`, id);
  return row ? rowToMailMessage(row) : null;
}

export async function listInbound(
  db: DbClient,
  q: { threadId?: string; cursor?: string; limit: number },
): Promise<common.Paginated<mail.MailMessage>> {
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
    items: page.map(rowToMailMessage),
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
