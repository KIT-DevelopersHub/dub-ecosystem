// D1 access for the notif_ namespace. Uses @dub/db DbClient (namespace-scoped,
// runtime-DDL-forbidden). Every SQL statement touches notif_* tables only.
import { type DbClient, newId, nowIso } from "@dub/db";
import { errors } from "@dub/errors";
import type { notification } from "@dub/types";
import { BROADCAST_IN_APP_TYPES, DEFAULT_AUDIENCE, AUDIENCE_ADMIN, BROADCAST_FROM_PREFIX } from "./config";
import type { NotificationAudience } from "./types";
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
  audience: string;
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
       (id, type, title, body, priority, audience, dedup_key, source, source_event, actor_id,
        request_id, resource_type, resource_id, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.type,
    input.title,
    input.body,
    input.priority,
    input.audience ?? DEFAULT_AUDIENCE,
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

/**
 * Lazily materialize any broadcast (release / system.announcement) inbox rows this user
 * is missing. Broadcasts are fanned out at PUBLISH time only, so a user created after a
 * broadcast (e.g. info@ / admin@ individualized later, or any late-joining member) never
 * received its inbox row and re-seeding is a no-op (dedup short-circuit). Calling this on
 * every inbox read guarantees every user always sees every broadcast, as unread. Cheap:
 * broadcasts are few, and already-present users insert nothing (NOT EXISTS + INSERT OR
 * IGNORE). Returns the number of rows newly created. notif_* tables only (@dub/db guard).
 */
export async function backfillBroadcastInbox(db: DbClient, userId: string): Promise<number> {
  const placeholders = BROADCAST_IN_APP_TYPES.map(() => "?").join(", ");
  const missing = await db.all<{ id: string }>(
    `SELECT n.id FROM notif_notifications n
      WHERE n.type IN (${placeholders})
        AND NOT EXISTS (
          SELECT 1 FROM notif_inbox i WHERE i.notification_id = n.id AND i.user_id = ?
        )`,
    ...BROADCAST_IN_APP_TYPES,
    userId,
  );
  for (const r of missing) {
    await insertInbox(db, r.id, userId);
  }
  return missing.length;
}

/**
 * Lazily materialize inbox rows for audience='admin' notifications this ADMIN user is
 * missing. The admin analogue of backfillBroadcastInbox: any notification created with
 * audience='admin' — feedback, deploy, ops alerts, OR a bare row written directly by CI
 * (deploy hook) that never fanned out to individual admins — becomes visible to every
 * admin/maintainer on their next inbox read, WITHOUT the producer needing to know admin
 * user ids. This is what lets the CI deploy-notify be a single idempotent INSERT of one
 * notification row. Callers MUST gate on isAdminViewer (only admins get admin-audience
 * rows). Idempotent (NOT EXISTS + INSERT OR IGNORE); cheap for the same reasons as the
 * broadcast backfill (retention purge bounds the admin-audience row count). Returns rows
 * newly created. notif_* tables only (@dub/db guard).
 */
export async function backfillAdminAudienceInbox(db: DbClient, userId: string): Promise<number> {
  const missing = await db.all<{ id: string }>(
    `SELECT n.id FROM notif_notifications n
      WHERE n.audience = ?
        AND NOT EXISTS (
          SELECT 1 FROM notif_inbox i WHERE i.notification_id = n.id AND i.user_id = ?
        )`,
    AUDIENCE_ADMIN,
    userId,
  );
  for (const r of missing) {
    await insertInbox(db, r.id, userId);
  }
  return missing.length;
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
    audience: (r.audience as NotificationAudience) ?? DEFAULT_AUDIENCE,
  };
}

/**
 * List a user's inbox. `includeAdminAudience` is true only for admin/maintainer viewers;
 * members pass false and never see audience='admin' rows (defense-in-depth on top of
 * fan-out, which already scopes admin notifications to admin roles). Members always keep
 * their own direct notifications, which are audience='members'.
 */
export async function listInbox(
  db: DbClient,
  userId: string,
  q: notification.ListInboxQuery & { limit: number },
  includeAdminAudience = false,
): Promise<notification.ListInboxResponse> {
  const where: string[] = ["i.user_id = ?"];
  const binds: unknown[] = [userId];
  if (!includeAdminAudience) {
    where.push("n.audience <> ?");
    binds.push(AUDIENCE_ADMIN);
  }
  if (q.unreadOnly) where.push("i.read_at IS NULL");
  if (q.cursor !== undefined) {
    where.push("i.id < ?");
    binds.push(decodeCursor(q.cursor));
  }
  const sql = `SELECT i.id, i.notification_id, i.user_id, i.read_at, i.created_at,
                      n.type, n.title, n.body, n.resource_type, n.resource_id, n.audience
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

export async function unreadCount(
  db: DbClient,
  userId: string,
  includeAdminAudience = false,
): Promise<number> {
  // Member unread counts exclude audience='admin' rows for parity with listInbox. The
  // JOIN is only needed for the audience filter; admin viewers keep the cheap COUNT.
  if (includeAdminAudience) {
    const row = await db.first<{ c: number }>(
      `SELECT COUNT(*) AS c FROM notif_inbox WHERE user_id = ? AND read_at IS NULL`,
      userId,
    );
    return row?.c ?? 0;
  }
  const row = await db.first<{ c: number }>(
    `SELECT COUNT(*) AS c FROM notif_inbox i
       JOIN notif_notifications n ON n.id = i.notification_id
      WHERE i.user_id = ? AND i.read_at IS NULL AND n.audience <> ?`,
    userId,
    AUDIENCE_ADMIN,
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

// ---- admin notification management (audience='admin' list + publish-to-members) ----

interface AdminNotifRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  audience: string;
  created_at: string;
  published_broadcast_id: string | null;
}

function rowToAdminItem(r: AdminNotifRow): notification.AdminNotificationItem {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    body: r.body ?? "",
    audience: (r.audience as NotificationAudience) ?? AUDIENCE_ADMIN,
    createdAt: r.created_at,
    publishedBroadcastId: r.published_broadcast_id,
  };
}

/**
 * Admin list: audience='admin' notifications newest-first (opaque id cursor). Each row is
 * LEFT-JOINed to the members broadcast derived from it (dedup_key = 'broadcast:from:'||id)
 * so `publishedBroadcastId` drives the "公開済み" badge without a second query.
 */
export async function listAdminNotifications(
  db: DbClient,
  q: notification.ListAdminNotificationsQuery & { limit: number },
): Promise<notification.ListAdminNotificationsResponse> {
  const where: string[] = ["n.audience = ?"];
  const binds: unknown[] = [AUDIENCE_ADMIN];
  if (q.cursor !== undefined) {
    where.push("n.id < ?");
    binds.push(decodeCursor(q.cursor));
  }
  const sql = `SELECT n.id, n.type, n.title, n.body, n.audience, n.created_at,
                      b.id AS published_broadcast_id
               FROM notif_notifications n
               LEFT JOIN notif_notifications b
                 ON b.dedup_key = ? || n.id
               WHERE ${where.join(" AND ")}
               ORDER BY n.id DESC
               LIMIT ?`;
  const rows = await db.all<AdminNotifRow>(sql, BROADCAST_FROM_PREFIX, ...binds, q.limit + 1);
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(rowToAdminItem),
    nextCursor: hasMore && last ? encodeCursor(last.id) : null,
  };
}

export interface SourceNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  audience: string;
}

/** Load a notification's publishable fields (title/body/audience) for member broadcast. */
export async function getNotificationById(db: DbClient, id: string): Promise<SourceNotification | null> {
  return db.first<SourceNotification>(
    `SELECT id, type, title, body, audience FROM notif_notifications WHERE id = ?`,
    id,
  );
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

// ---- in-app feedback (append-only content; read_at is the sole mutable column) ----

interface FeedbackRow {
  id: string;
  user_id: string;
  category: notification.FeedbackCategory;
  message: string;
  page_url: string | null;
  page_name: string | null;
  user_agent: string | null;
  request_id: string;
  read_at: string | null;
  created_at: string;
}

function rowToFeedbackItem(r: FeedbackRow): notification.FeedbackItem {
  return {
    id: r.id,
    userId: r.user_id,
    category: r.category,
    message: r.message,
    pageUrl: r.page_url,
    pageName: r.page_name,
    readAt: r.read_at,
    createdAt: r.created_at,
  };
}

export interface InsertFeedbackInput {
  userId: string;
  category: notification.FeedbackCategory;
  message: string;
  pageUrl: string | null;
  pageName: string | null;
  userAgent: string | null;
  requestId: string;
}

/** Append one feedback record. Returns the persisted item. */
export async function insertFeedback(db: DbClient, input: InsertFeedbackInput): Promise<notification.FeedbackItem> {
  const id = newId("nfb");
  const now = nowIso();
  await db.run(
    `INSERT INTO notif_feedback
       (id, user_id, category, message, page_url, page_name, user_agent, request_id, read_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    id,
    input.userId,
    input.category,
    input.message,
    input.pageUrl,
    input.pageName,
    input.userAgent,
    input.requestId,
    now,
  );
  const row = await db.first<FeedbackRow>(
    `SELECT id, user_id, category, message, page_url, page_name, user_agent, request_id, read_at, created_at
     FROM notif_feedback WHERE id = ?`,
    id,
  );
  if (!row) throw new Error("feedback insert readback failed");
  return rowToFeedbackItem(row);
}

/** Admin list, newest-first, opaque id cursor. `unreadOnly` restricts to read_at IS NULL. */
export async function listFeedback(
  db: DbClient,
  q: notification.ListFeedbackQuery & { limit: number },
): Promise<notification.ListFeedbackResponse> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (q.unreadOnly) where.push("read_at IS NULL");
  if (q.cursor !== undefined) {
    where.push("id < ?");
    binds.push(decodeCursor(q.cursor));
  }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await db.all<FeedbackRow>(
    `SELECT id, user_id, category, message, page_url, page_name, user_agent, request_id, read_at, created_at
     FROM notif_feedback ${clause}
     ORDER BY id DESC
     LIMIT ?`,
    ...binds,
    q.limit + 1,
  );
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(rowToFeedbackItem),
    nextCursor: hasMore && last ? encodeCursor(last.id) : null,
  };
}

/** Mark a feedback item read (idempotent: read_at keeps its first value). Returns
 *  false when the id does not exist. */
export async function markFeedbackRead(db: DbClient, id: string): Promise<boolean> {
  const row = await db.first<{ id: string }>(`SELECT id FROM notif_feedback WHERE id = ?`, id);
  if (!row) return false;
  await db.run(`UPDATE notif_feedback SET read_at = ? WHERE id = ? AND read_at IS NULL`, nowIso(), id);
  return true;
}

export type { NotificationRow, InboxRow, PreferenceRow, FeedbackRow };
