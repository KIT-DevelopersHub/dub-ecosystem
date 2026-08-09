// D1 access for the notif_ namespace. Uses @dub/db DbClient (namespace-scoped,
// runtime-DDL-forbidden). Every SQL statement touches notif_* tables only.
import { type DbClient, newId, nowIso } from "@dub/db";
import { errors } from "@dub/errors";
import type { notification } from "@dub/types";
import type {
  DeliveryOutcome,
  IngestInput,
  NotificationChannel,
} from "./types";

// ---- row shapes ----
interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  priority: string;
  dedup_key: string | null;
  source: string;
  source_event: string | null;
  actor_id: string | null;
  request_id: string;
  resource_type: string | null;
  resource_id: string | null;
  meta_json: string;
  created_at: string;
}

interface InboxRow {
  id: string;
  notification_id: string;
  user_id: string;
  read_at: string | null;
  created_at: string;
  type: string;
  title: string;
  body: string | null;
  resource_type: string | null;
  resource_id: string | null;
}

interface PreferenceRow {
  user_id: string;
  type: string;
  channel: string;
  enabled: number;
  updated_at: string;
}

// ---- cursor codec (opaque base64url of the inbox row id; D3) ----
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

// ---- notifications ----

/** Look up an existing notification id by its business dedup key (design §6). */
export async function findByDedupKey(db: DbClient, dedupKey: string): Promise<string | null> {
  const row = await db.first<{ id: string }>(
    `SELECT id FROM notif_notifications WHERE dedup_key = ?`,
    dedupKey,
  );
  return row?.id ?? null;
}

/** Insert the canonical notification row (body stored once, not per recipient). */
export async function insertNotification(db: DbClient, input: IngestInput): Promise<string> {
  const id = newId("ntfn");
  await db.run(
    `INSERT INTO notif_notifications
       (id, type, title, body, priority, dedup_key, source, source_event, actor_id,
        request_id, resource_type, resource_id, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.type,
    input.title,
    input.body,
    input.priority,
    input.dedupKey ?? null,
    input.source,
    input.sourceEvent ?? null,
    input.actorId,
    input.requestId,
    input.resourceType ?? null,
    input.resourceId ?? null,
    JSON.stringify(input.meta ?? {}),
    nowIso(),
  );
  return id;
}

// ---- inbox (in_app source of truth) ----

/** Insert an inbox row (idempotent via the (notification_id,user_id) unique key). */
export async function insertInbox(db: DbClient, notificationId: string, userId: string): Promise<void> {
  await db.run(
    `INSERT OR IGNORE INTO notif_inbox (id, notification_id, user_id, read_at, created_at)
     VALUES (?, ?, ?, NULL, ?)`,
    newId("ntfi"),
    notificationId,
    userId,
    nowIso(),
  );
}

function rowToInboxItem(r: InboxRow): notification.InboxItem {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    body: r.body ?? "",
    readAt: r.read_at,
    createdAt: r.created_at,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
  };
}

export async function listInbox(
  db: DbClient,
  userId: string,
  q: notification.ListInboxQuery & { limit: number },
): Promise<notification.ListInboxResponse> {
  const where: string[] = ["i.user_id = ?"];
  const binds: unknown[] = [userId];
  if (q.unreadOnly) where.push("i.read_at IS NULL");
  if (q.cursor !== undefined) {
    where.push("i.id < ?");
    binds.push(decodeCursor(q.cursor));
  }
  const sql = `SELECT i.id, i.notification_id, i.user_id, i.read_at, i.created_at,
                      n.type, n.title, n.body, n.resource_type, n.resource_id
               FROM notif_inbox i
               JOIN notif_notifications n ON n.id = i.notification_id
               WHERE ${where.join(" AND ")}
               ORDER BY i.id DESC
               LIMIT ?`;
  const rows = await db.all<InboxRow>(sql, ...binds, q.limit + 1);
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(rowToInboxItem),
    nextCursor: hasMore && last ? encodeCursor(last.id) : null,
  };
}

export async function unreadCount(db: DbClient, userId: string): Promise<number> {
  const row = await db.first<{ c: number }>(
    `SELECT COUNT(*) AS c FROM notif_inbox WHERE user_id = ? AND read_at IS NULL`,
    userId,
  );
  return row?.c ?? 0;
}

/**
 * Mark a single inbox row read (idempotent: read_at keeps the first value).
 * Returns false when the row does not exist or belongs to another user.
 */
export async function markRead(db: DbClient, userId: string, inboxId: string): Promise<boolean> {
  const row = await db.first<{ id: string }>(
    `SELECT id FROM notif_inbox WHERE id = ? AND user_id = ?`,
    inboxId,
    userId,
  );
  if (!row) return false;
  await db.run(
    `UPDATE notif_inbox SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL`,
    nowIso(),
    inboxId,
    userId,
  );
  return true;
}

/** Mark every unread row read (optionally scoped to a type prefix). Returns count. */
export async function markAllRead(db: DbClient, userId: string, typePrefix?: string): Promise<number> {
  if (typePrefix !== undefined) {
    const res = await db.run(
      `UPDATE notif_inbox SET read_at = ?
       WHERE user_id = ? AND read_at IS NULL
         AND notification_id IN (
           SELECT id FROM notif_notifications WHERE type LIKE ? ESCAPE '\\'
         )`,
      nowIso(),
      userId,
      escapeLike(typePrefix) + "%",
    );
    return res.meta.changes;
  }
  const res = await db.run(
    `UPDATE notif_inbox SET read_at = ? WHERE user_id = ? AND read_at IS NULL`,
    nowIso(),
    userId,
  );
  return res.meta.changes;
}

function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

// ---- deliveries ----

export async function recordDelivery(
  db: DbClient,
  notificationId: string,
  userId: string,
  channel: NotificationChannel,
  status: DeliveryOutcome | "queued",
  attempts: number,
  lastError: string | null,
): Promise<void> {
  // UPDATE-then-INSERT rather than "ON CONFLICT DO UPDATE SET": the @dub/db namespace
  // guard parses the token after "UPDATE", and in "DO UPDATE SET" that token is "SET".
  const now = nowIso();
  const upd = await db.run(
    `UPDATE notif_deliveries
       SET status = ?, attempts = ?, last_error = ?, updated_at = ?
     WHERE notification_id = ? AND user_id = ? AND channel = ?`,
    status,
    attempts,
    lastError,
    now,
    notificationId,
    userId,
    channel,
  );
  if (upd.meta.changes === 0) {
    await db.run(
      `INSERT OR IGNORE INTO notif_deliveries
         (id, notification_id, user_id, channel, status, attempts, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId("ntfd"),
      notificationId,
      userId,
      channel,
      status,
      attempts,
      lastError,
      now,
      now,
    );
  }
}

// ---- preferences ----

export async function listPreferenceOverrides(db: DbClient, userId: string): Promise<PreferenceRow[]> {
  return db.all<PreferenceRow>(
    `SELECT user_id, type, channel, enabled, updated_at FROM notif_preferences WHERE user_id = ?`,
    userId,
  );
}

/** Upsert one (user,type,channel) override row. */
export async function upsertPreference(
  db: DbClient,
  userId: string,
  type: string,
  channel: NotificationChannel,
  enabled: boolean,
): Promise<void> {
  const now = nowIso();
  const upd = await db.run(
    `UPDATE notif_preferences SET enabled = ?, updated_at = ?
     WHERE user_id = ? AND type = ? AND channel = ?`,
    enabled ? 1 : 0,
    now,
    userId,
    type,
    channel,
  );
  if (upd.meta.changes === 0) {
    await db.run(
      `INSERT OR IGNORE INTO notif_preferences (user_id, type, channel, enabled, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      userId,
      type,
      channel,
      enabled ? 1 : 0,
      now,
    );
  }
}

export async function deletePreference(
  db: DbClient,
  userId: string,
  type: string,
  channel: NotificationChannel,
): Promise<void> {
  await db.run(
    `DELETE FROM notif_preferences WHERE user_id = ? AND type = ? AND channel = ?`,
    userId,
    type,
    channel,
  );
}

// ---- retention purge (scheduled) ----

export async function purgeOlderThan(
  db: DbClient,
  inboxCutoff: string,
  deliveriesCutoff: string,
  processedCutoff: string,
): Promise<{ inbox: number; deliveries: number; processed: number }> {
  const inbox = (await db.run(`DELETE FROM notif_inbox WHERE created_at < ?`, inboxCutoff)).meta.changes;
  const deliveries = (await db.run(`DELETE FROM notif_deliveries WHERE created_at < ?`, deliveriesCutoff)).meta.changes;
  const processed = (await db.run(`DELETE FROM notif_processed_events WHERE processed_at < ?`, processedCutoff)).meta.changes;
  return { inbox, deliveries, processed };
}

export type { NotificationRow, InboxRow, PreferenceRow };
