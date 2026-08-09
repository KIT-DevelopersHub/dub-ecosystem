// D1 access for the webhook_deliveries table (namespace "webhook").
// Dedup = UNIQUE(source, external_id) + INSERT OR IGNORE. Signature-failed requests
// are never written here (attacker fill-up prevention) — that is the route's job.
import type { DbClient } from "@dub/db";
import type { webhook } from "@dub/types";

export interface DeliveryRecord {
  id: string; // newId("wh")
  source: webhook.WebhookSource;
  externalId: string;
  eventKind: string;
  status: webhook.WebhookDeliveryStatus; // stored rows are always "received" at ingest
  queue: string; // published queue physical name
  r2Key: string | null;
  bodySize: number;
  receivedAt: string; // ISO8601 (app-side nowIso; DDL has no DEFAULT — D2)
  processedAt: string | null;
  requestId: string;
}

export interface InsertResult {
  inserted: boolean;
  existingId: string | null; // set when a duplicate already existed
}

export interface PurgeResult {
  deletedIds: string[];
  r2Keys: string[]; // r2 keys of purged rows (caller deletes the objects)
}

export interface DeliveryRepo {
  insertIfNew(rec: DeliveryRecord): Promise<InsertResult>;
  deleteById(id: string): Promise<void>;
  getById(id: string): Promise<webhook.WebhookDelivery | null>;
  query(q: webhook.WebhookDeliveryQuery): Promise<webhook.WebhookDeliveryPage>;
  purgeOlderThan(cutoffIso: string): Promise<PurgeResult>;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function clampLimit(limit: number | undefined): number {
  if (!limit || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

// Opaque cursor = base64url of the last row id (ULID = time-sortable, ORDER BY id DESC).
export function encodeCursor(id: string): string {
  return btoa(id).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decodeCursor(cursor: string): string | null {
  try {
    const b64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(b64);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

interface DeliveryRow {
  id: string;
  source: string;
  event_kind: string;
  status: string;
  received_at: string;
  processed_at: string | null;
}

function toDelivery(row: DeliveryRow): webhook.WebhookDelivery {
  return {
    id: row.id,
    source: row.source as webhook.WebhookSource,
    eventKind: row.event_kind,
    status: row.status as webhook.WebhookDeliveryStatus,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
  };
}

const INSERT_SQL = `INSERT OR IGNORE INTO webhook_deliveries
  (id, source, external_id, event_kind, status, queue, r2_key, body_size, received_at, processed_at, request_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const SELECT_EXISTING_ID = "SELECT id FROM webhook_deliveries WHERE source = ? AND external_id = ?";

const SELECT_PROJECTION = "id, source, event_kind, status, received_at, processed_at";

export function createDeliveryRepo(db: DbClient): DeliveryRepo {
  return {
    async insertIfNew(rec: DeliveryRecord): Promise<InsertResult> {
      const res = await db.run(
        INSERT_SQL,
        rec.id,
        rec.source,
        rec.externalId,
        rec.eventKind,
        rec.status,
        rec.queue,
        rec.r2Key,
        rec.bodySize,
        rec.receivedAt,
        rec.processedAt,
        rec.requestId,
      );
      if (res.meta.changes > 0) return { inserted: true, existingId: null };
      const existing = await db.first<{ id: string }>(SELECT_EXISTING_ID, rec.source, rec.externalId);
      return { inserted: false, existingId: existing?.id ?? null };
    },

    async deleteById(id: string): Promise<void> {
      await db.run("DELETE FROM webhook_deliveries WHERE id = ?", id);
    },

    async getById(id: string): Promise<webhook.WebhookDelivery | null> {
      const row = await db.first<DeliveryRow>(
        `SELECT ${SELECT_PROJECTION} FROM webhook_deliveries WHERE id = ?`,
        id,
      );
      return row ? toDelivery(row) : null;
    },

    async query(q: webhook.WebhookDeliveryQuery): Promise<webhook.WebhookDeliveryPage> {
      const limit = clampLimit(q.limit);
      const where: string[] = [];
      const binds: unknown[] = [];
      if (q.source) {
        where.push("source = ?");
        binds.push(q.source);
      }
      if (q.status) {
        where.push("status = ?");
        binds.push(q.status);
      }
      if (q.cursor) {
        const afterId = decodeCursor(q.cursor);
        if (afterId) {
          where.push("id < ?"); // keyset: newest first, id DESC
          binds.push(afterId);
        }
      }
      const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      const sql = `SELECT ${SELECT_PROJECTION} FROM webhook_deliveries ${whereSql} ORDER BY id DESC LIMIT ?`;
      binds.push(limit + 1); // fetch one extra to detect a next page

      const rows = await db.all<DeliveryRow>(sql, ...binds);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const items = page.map(toDelivery);
      const nextCursor = hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]!.id) : null;
      return { items, nextCursor };
    },

    async purgeOlderThan(cutoffIso: string): Promise<PurgeResult> {
      const rows = await db.all<{ id: string; r2_key: string | null }>(
        "SELECT id, r2_key FROM webhook_deliveries WHERE received_at < ?",
        cutoffIso,
      );
      if (rows.length === 0) return { deletedIds: [], r2Keys: [] };
      await db.run("DELETE FROM webhook_deliveries WHERE received_at < ?", cutoffIso);
      return {
        deletedIds: rows.map((r) => r.id),
        r2Keys: rows.map((r) => r.r2_key).filter((k): k is string => k !== null),
      };
    },
  };
}
