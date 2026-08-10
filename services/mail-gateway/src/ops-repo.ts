// D1 access for the Gmail-parity操作系 slice (flags / labels / drafts / sent / outbox).
// Every statement touches mail_* tables only (namespace-scoped DbClient). Kept in its
// own module so the frozen send/inbound repo.ts stays a small, low-conflict diff.
import { type DbClient, newId, nowIso } from "@dub/db";
import { errors } from "@dub/errors";
import type { common, mail } from "@dub/types";
import type { MailDraft, MailLabel, SentMailListItem } from "./ops-dto";
import { decodeCursor, encodeCursor } from "./repo";

// ---- id mints ----
export const newLabelId = (): string => newId("maillbl");
export const newDraftId = (): string => newId("maildft");
export const newOutboxId = (): string => newId("mailob");

// ======================= per-message flags =======================
// star / archive / trash are nullable ISO8601 stamps on mail_inbound. Setting a flag
// stamps nowIso; clearing sets NULL. Each returns whether the message exists (404 gate).
async function inboundExists(db: DbClient, id: string): Promise<boolean> {
  const row = await db.first<{ id: string }>(`SELECT id FROM mail_inbound WHERE id = ?`, id);
  return row !== null;
}

async function setFlag(db: DbClient, id: string, column: "starred_at" | "archived_at" | "trashed_at", on: boolean): Promise<{ found: boolean }> {
  if (!(await inboundExists(db, id))) return { found: false };
  // idempotent: only stamp when turning on and currently off (don't overwrite the first stamp).
  if (on) await db.run(`UPDATE mail_inbound SET ${column} = ? WHERE id = ? AND ${column} IS NULL`, nowIso(), id);
  else await db.run(`UPDATE mail_inbound SET ${column} = NULL WHERE id = ?`, id);
  return { found: true };
}

export const setStarred = (db: DbClient, id: string, on: boolean) => setFlag(db, id, "starred_at", on);
export const setArchived = (db: DbClient, id: string, on: boolean) => setFlag(db, id, "archived_at", on);
export const setTrashed = (db: DbClient, id: string, on: boolean) => setFlag(db, id, "trashed_at", on);

/** Flip read state back to unread (companion to repo.markInboundRead). */
export async function markInboundUnread(db: DbClient, id: string): Promise<{ found: boolean }> {
  if (!(await inboundExists(db, id))) return { found: false };
  await db.run(`UPDATE mail_inbound SET read_at = NULL WHERE id = ?`, id);
  return { found: true };
}

/** Permanent delete (from Trash or anywhere). Also drops its label links. */
export async function deleteInbound(db: DbClient, id: string): Promise<{ found: boolean }> {
  if (!(await inboundExists(db, id))) return { found: false };
  await db.run(`DELETE FROM mail_message_labels WHERE message_id = ?`, id);
  await db.run(`DELETE FROM mail_inbound WHERE id = ?`, id);
  return { found: true };
}

// ---- thread-level flags (Gmail stars/archives/trashes the whole conversation) ----
export async function setThreadFlag(
  db: DbClient,
  threadId: string,
  column: "starred_at" | "archived_at" | "trashed_at",
  on: boolean,
): Promise<{ affected: number }> {
  const value = on ? nowIso() : null;
  const res = on
    ? await db.run(`UPDATE mail_inbound SET ${column} = ? WHERE thread_id = ? AND ${column} IS NULL`, value, threadId)
    : await db.run(`UPDATE mail_inbound SET ${column} = NULL WHERE thread_id = ?`, threadId);
  return { affected: res.meta.changes };
}

// ======================= labels =======================
interface LabelRow {
  id: string;
  name: string;
  color: string | null;
  created_at: string;
  updated_at: string;
}
const rowToLabel = (r: LabelRow): MailLabel => ({ id: r.id, name: r.name, color: r.color });

export async function listLabels(db: DbClient): Promise<MailLabel[]> {
  const rows = await db.all<LabelRow>(`SELECT * FROM mail_labels ORDER BY name ASC`);
  return rows.map(rowToLabel);
}

export async function getLabel(db: DbClient, id: string): Promise<MailLabel | null> {
  const row = await db.first<LabelRow>(`SELECT * FROM mail_labels WHERE id = ?`, id);
  return row ? rowToLabel(row) : null;
}

/** Create a label; a duplicate name → 409 (names are unique). */
export async function createLabel(db: DbClient, name: string, color: string | null): Promise<MailLabel> {
  const dup = await db.first<{ id: string }>(`SELECT id FROM mail_labels WHERE name = ?`, name);
  if (dup) throw errors.conflict(`label name already exists: ${name}`);
  const id = newLabelId();
  const now = nowIso();
  await db.run(`INSERT INTO mail_labels (id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, id, name, color, now, now);
  return { id, name, color };
}

/** Update a label's name/color. Returns null when the id is unknown. */
export async function updateLabel(db: DbClient, id: string, patch: { name?: string; color?: string | null }): Promise<MailLabel | null> {
  const cur = await db.first<LabelRow>(`SELECT * FROM mail_labels WHERE id = ?`, id);
  if (!cur) return null;
  const name = patch.name ?? cur.name;
  const color = patch.color !== undefined ? patch.color : cur.color;
  if (patch.name !== undefined && patch.name !== cur.name) {
    const dup = await db.first<{ id: string }>(`SELECT id FROM mail_labels WHERE name = ? AND id <> ?`, name, id);
    if (dup) throw errors.conflict(`label name already exists: ${name}`);
  }
  await db.run(`UPDATE mail_labels SET name = ?, color = ?, updated_at = ? WHERE id = ?`, name, color, nowIso(), id);
  return { id, name, color };
}

export async function deleteLabel(db: DbClient, id: string): Promise<{ found: boolean }> {
  const cur = await db.first<{ id: string }>(`SELECT id FROM mail_labels WHERE id = ?`, id);
  if (!cur) return { found: false };
  await db.run(`DELETE FROM mail_message_labels WHERE label_id = ?`, id);
  await db.run(`DELETE FROM mail_labels WHERE id = ?`, id);
  return { found: true };
}

/** Apply a label to a message (idempotent). Reports whether each side existed. */
export async function applyLabel(db: DbClient, messageId: string, labelId: string): Promise<{ messageFound: boolean; labelFound: boolean }> {
  const messageFound = await inboundExists(db, messageId);
  const labelFound = (await db.first<{ id: string }>(`SELECT id FROM mail_labels WHERE id = ?`, labelId)) !== null;
  if (!messageFound || !labelFound) return { messageFound, labelFound };
  await db.run(
    `INSERT OR IGNORE INTO mail_message_labels (message_id, label_id, created_at) VALUES (?, ?, ?)`,
    messageId,
    labelId,
    nowIso(),
  );
  return { messageFound: true, labelFound: true };
}

export async function removeLabel(db: DbClient, messageId: string, labelId: string): Promise<{ found: boolean }> {
  if (!(await inboundExists(db, messageId))) return { found: false };
  await db.run(`DELETE FROM mail_message_labels WHERE message_id = ? AND label_id = ?`, messageId, labelId);
  return { found: true };
}

// NOTE: the read-side enrichment helper `labelsForMessages` lives in repo.ts (next to
// the inbound row mappers it feeds) so this write-side module never imports back into
// repo's list path — keeping the module graph acyclic.

// ======================= drafts =======================
interface DraftRow {
  id: string;
  to_json: string;
  cc_json: string | null;
  subject: string;
  text_body: string;
  html_body: string | null;
  in_reply_to: string | null;
  thread_id: string | null;
  created_at: string;
  updated_at: string;
}
function rowToDraft(r: DraftRow): MailDraft {
  const d: MailDraft = {
    id: r.id,
    to: JSON.parse(r.to_json) as mail.MailAddress[],
    subject: r.subject,
    textBody: r.text_body,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.cc_json) d.cc = JSON.parse(r.cc_json) as mail.MailAddress[];
  if (r.html_body !== null) d.htmlBody = r.html_body;
  if (r.in_reply_to !== null) d.inReplyTo = r.in_reply_to;
  if (r.thread_id !== null) d.threadId = r.thread_id;
  return d;
}

export interface DraftInput {
  to: mail.MailAddress[];
  cc?: mail.MailAddress[];
  subject: string;
  textBody: string;
  htmlBody?: string;
  inReplyTo?: string;
  threadId?: string;
}

export async function listDrafts(db: DbClient): Promise<MailDraft[]> {
  const rows = await db.all<DraftRow>(`SELECT * FROM mail_drafts ORDER BY updated_at DESC, id DESC`);
  return rows.map(rowToDraft);
}

export async function getDraft(db: DbClient, id: string): Promise<MailDraft | null> {
  const row = await db.first<DraftRow>(`SELECT * FROM mail_drafts WHERE id = ?`, id);
  return row ? rowToDraft(row) : null;
}

export async function createDraft(db: DbClient, input: DraftInput): Promise<MailDraft> {
  const id = newDraftId();
  const now = nowIso();
  await db.run(
    `INSERT INTO mail_drafts (id, to_json, cc_json, subject, text_body, html_body, in_reply_to, thread_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    JSON.stringify(input.to),
    input.cc ? JSON.stringify(input.cc) : null,
    input.subject,
    input.textBody,
    input.htmlBody ?? null,
    input.inReplyTo ?? null,
    input.threadId ?? null,
    now,
    now,
  );
  return (await getDraft(db, id))!;
}

/** Full replace (PUT semantics) of a draft. Returns null on unknown id. */
export async function updateDraft(db: DbClient, id: string, input: DraftInput): Promise<MailDraft | null> {
  const cur = await db.first<{ id: string }>(`SELECT id FROM mail_drafts WHERE id = ?`, id);
  if (!cur) return null;
  await db.run(
    `UPDATE mail_drafts SET to_json = ?, cc_json = ?, subject = ?, text_body = ?, html_body = ?, in_reply_to = ?, thread_id = ?, updated_at = ?
     WHERE id = ?`,
    JSON.stringify(input.to),
    input.cc ? JSON.stringify(input.cc) : null,
    input.subject,
    input.textBody,
    input.htmlBody ?? null,
    input.inReplyTo ?? null,
    input.threadId ?? null,
    nowIso(),
    id,
  );
  return getDraft(db, id);
}

export async function deleteDraft(db: DbClient, id: string): Promise<{ found: boolean }> {
  const res = await db.run(`DELETE FROM mail_drafts WHERE id = ?`, id);
  return { found: res.meta.changes > 0 };
}

// ======================= sent folder (projected from the send-log) =======================
interface SendLogListRow {
  id: string;
  provider_message_id: string | null;
  thread_id: string | null;
  to_json: string;
  subject: string;
  provider: string | null;
  status: "pending" | "sent" | "failed";
  created_at: string;
}
export async function listSent(db: DbClient, q: { cursor?: string; limit: number }): Promise<common.Paginated<SentMailListItem>> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (q.cursor !== undefined) {
    where.push("id < ?");
    binds.push(decodeCursor(q.cursor));
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await db.all<SendLogListRow>(
    `SELECT id, provider_message_id, thread_id, to_json, subject, provider, status, created_at
       FROM mail_send_log ${whereSql} ORDER BY id DESC LIMIT ?`,
    ...binds,
    q.limit + 1,
  );
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: r.id,
      messageId: r.provider_message_id ?? r.id,
      threadId: r.thread_id,
      to: JSON.parse(r.to_json) as mail.MailAddress[],
      subject: r.subject,
      provider: r.provider,
      status: r.status,
      sentAt: r.created_at,
    })),
    nextCursor: hasMore && last ? encodeCursor(last.id) : null,
  };
}

// ======================= freeq D1 outbox =======================
export interface OutboxRow {
  id: string;
  kind: string;
  payload_json: string;
  status: "pending" | "done" | "failed";
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** Append an async job to the D1 outbox (no Cloudflare Queue). Drained by the cron. */
export async function enqueueOutbox(db: DbClient, kind: string, payload: unknown): Promise<string> {
  const id = newOutboxId();
  const now = nowIso();
  await db.run(
    `INSERT INTO mail_outbox (id, kind, payload_json, status, attempts, next_attempt_at, last_error, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 0, ?, NULL, ?, ?)`,
    id,
    kind,
    JSON.stringify(payload),
    now,
    now,
    now,
  );
  return id;
}

/** Claim due pending rows (status=pending AND next_attempt_at <= now), oldest first. */
export async function claimOutboxPending(db: DbClient, nowIsoStr: string, limit: number): Promise<OutboxRow[]> {
  return db.all<OutboxRow>(
    `SELECT * FROM mail_outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at ASC, id ASC LIMIT ?`,
    nowIsoStr,
    limit,
  );
}

export async function markOutboxDone(db: DbClient, id: string): Promise<void> {
  await db.run(`UPDATE mail_outbox SET status = 'done', updated_at = ? WHERE id = ?`, nowIso(), id);
}

/** Record a failed drain attempt: bump attempts, back off next_attempt_at; after
 *  maxAttempts mark it 'failed' (dead-letter) so it stops being reclaimed. */
export async function bumpOutboxFailure(db: DbClient, row: OutboxRow, nextAttemptAt: string, error: string, maxAttempts: number): Promise<void> {
  const attempts = row.attempts + 1;
  const status = attempts >= maxAttempts ? "failed" : "pending";
  await db.run(
    `UPDATE mail_outbox SET attempts = ?, status = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
    attempts,
    status,
    nextAttemptAt,
    error.slice(0, 500),
    nowIso(),
    row.id,
  );
}
