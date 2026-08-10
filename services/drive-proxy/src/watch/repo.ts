// D1 access for the drive_watch_channels registry. drive-proxy owns this operational
// state directly (thin D1Database wrapper) rather than through @dub/db's namespace
// client, because "drive" is not a registered schema namespace (file-meta owns Drive
// metadata; this is channel lifecycle only). The shared channel token is NEVER stored
// (only token_version), keeping the secret in Workers Secrets alone.
import type { D1Database } from "@cloudflare/workers-types";
import { DubError } from "@dub/errors";

export type WatchChannelStatus = "active" | "stopped";
export type WatchTokenVersion = "current" | "next";

export interface WatchChannelRecord {
  id: string; // newId("dwc")
  channelId: string; // X-Goog-Channel-Id (opaque uuid)
  resourceId: string; // Google resourceId (needed to stop)
  fileId: string; // watched Drive file/folder id
  tokenVersion: WatchTokenVersion; // which secret slot minted the channel token
  address: string; // https callback (webhook-ingest ingress)
  expiration: string | null; // ISO8601 channel expiry
  status: WatchChannelStatus;
  actorId: string | null;
  requestId: string;
  createdAt: string;
  updatedAt: string;
}

export interface WatchChannelRepo {
  insert(rec: WatchChannelRecord): Promise<void>;
  getByChannelId(channelId: string): Promise<WatchChannelRecord | null>;
  getActiveByFileId(fileId: string): Promise<WatchChannelRecord | null>;
  /** Flip an active channel to stopped. Returns true iff a row transitioned. */
  markStopped(channelId: string, at: string): Promise<boolean>;
  listActive(): Promise<WatchChannelRecord[]>;
  /** Active channels whose expiration is <= cutoff (renewal candidates). */
  listExpiringBefore(cutoffIso: string): Promise<WatchChannelRecord[]>;
}

interface WatchRow {
  id: string;
  channel_id: string;
  resource_id: string;
  file_id: string;
  token_version: string;
  address: string;
  expiration: string | null;
  status: string;
  actor_id: string | null;
  request_id: string;
  created_at: string;
  updated_at: string;
}

const COLS =
  "id, channel_id, resource_id, file_id, token_version, address, expiration, status, actor_id, request_id, created_at, updated_at";

const INSERT_SQL = `INSERT INTO drive_watch_channels
  (id, channel_id, resource_id, file_id, token_version, address, expiration, status, actor_id, request_id, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function toRecord(row: WatchRow): WatchChannelRecord {
  return {
    id: row.id,
    channelId: row.channel_id,
    resourceId: row.resource_id,
    fileId: row.file_id,
    tokenVersion: row.token_version as WatchTokenVersion,
    address: row.address,
    expiration: row.expiration,
    status: row.status as WatchChannelStatus,
    actorId: row.actor_id,
    requestId: row.request_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function guard<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (cause) {
    throw new DubError("DB_QUERY_FAILED", `drive_watch_channels ${what} failed`, { status: 500, cause });
  }
}

export function createWatchChannelRepo(d1: D1Database): WatchChannelRepo {
  return {
    async insert(rec): Promise<void> {
      await guard("insert", () =>
        d1
          .prepare(INSERT_SQL)
          .bind(
            rec.id,
            rec.channelId,
            rec.resourceId,
            rec.fileId,
            rec.tokenVersion,
            rec.address,
            rec.expiration,
            rec.status,
            rec.actorId,
            rec.requestId,
            rec.createdAt,
            rec.updatedAt,
          )
          .run(),
      );
    },

    async getByChannelId(channelId): Promise<WatchChannelRecord | null> {
      const row = await guard("getByChannelId", () =>
        d1.prepare(`SELECT ${COLS} FROM drive_watch_channels WHERE channel_id = ?`).bind(channelId).first<WatchRow>(),
      );
      return row ? toRecord(row) : null;
    },

    async getActiveByFileId(fileId): Promise<WatchChannelRecord | null> {
      const row = await guard("getActiveByFileId", () =>
        d1
          .prepare(
            `SELECT ${COLS} FROM drive_watch_channels WHERE file_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
          )
          .bind(fileId)
          .first<WatchRow>(),
      );
      return row ? toRecord(row) : null;
    },

    async markStopped(channelId, at): Promise<boolean> {
      const res = await guard("markStopped", () =>
        d1
          .prepare(
            "UPDATE drive_watch_channels SET status = 'stopped', updated_at = ? WHERE channel_id = ? AND status = 'active'",
          )
          .bind(at, channelId)
          .run(),
      );
      return (res.meta?.changes ?? 0) > 0;
    },

    async listActive(): Promise<WatchChannelRecord[]> {
      const res = await guard("listActive", () =>
        d1
          .prepare(`SELECT ${COLS} FROM drive_watch_channels WHERE status = 'active' ORDER BY created_at DESC`)
          .all<WatchRow>(),
      );
      return (res.results ?? []).map(toRecord);
    },

    async listExpiringBefore(cutoffIso): Promise<WatchChannelRecord[]> {
      const res = await guard("listExpiringBefore", () =>
        d1
          .prepare(
            `SELECT ${COLS} FROM drive_watch_channels WHERE status = 'active' AND expiration IS NOT NULL AND expiration <= ? ORDER BY expiration ASC`,
          )
          .bind(cutoffIso)
          .all<WatchRow>(),
      );
      return (res.results ?? []).map(toRecord);
    },
  };
}
