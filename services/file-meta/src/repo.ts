// file-meta data access (file_meta_* namespace). D1-backed via @dub/db DbClient.
// Handlers depend on FileRepo (deps.ts); tests inject the in-memory implementation.
import type { DbClient } from "@dub/db";
import type { IdempotencyStore } from "@dub/events";
import type { fileMeta } from "@dub/types";
import { nowIso } from "@dub/db";
import type { CreateFileInput, FileRecord, FileRepo, SearchFilter, StoredLink, UpdateFilePatch } from "./deps";

interface FileRow {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  owner_id: string;
  visibility: string;
  drive_file_id: string | null;
  r2_key: string | null;
  archived_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}
interface LinkRow {
  file_id: string;
  target_type: string;
  target_id: string;
  linked_by: string;
  linked_at: string;
  archived_at: string | null;
}

function toRecord(r: FileRow): FileRecord {
  return {
    id: r.id,
    name: r.name,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes,
    ownerId: r.owner_id,
    visibility: r.visibility as fileMeta.FileVisibility,
    driveFileId: r.drive_file_id,
    r2Key: r.r2_key,
    createdBy: r.created_by,
    archivedAt: r.archived_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const encodeCursor = (id: string): string => btoa(id);
const decodeCursor = (c: string): string => {
  try {
    return atob(c);
  } catch {
    return "";
  }
};

export function createD1FileRepo(db: DbClient): FileRepo {
  return {
    async createFile(input: CreateFileInput): Promise<FileRecord> {
      await db.run(
        `INSERT INTO file_meta_files
           (id, name, mime_type, size_bytes, owner_id, visibility, drive_file_id, r2_key, archived_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        input.id, input.name, input.mimeType, input.sizeBytes, input.ownerId, input.visibility,
        input.driveFileId, input.r2Key, input.createdBy, input.createdAt, input.updatedAt,
      );
      return {
        id: input.id, name: input.name, mimeType: input.mimeType, sizeBytes: input.sizeBytes,
        ownerId: input.ownerId, visibility: input.visibility, driveFileId: input.driveFileId,
        r2Key: input.r2Key, createdBy: input.createdBy, archivedAt: null,
        createdAt: input.createdAt, updatedAt: input.updatedAt,
      };
    },

    async getFile(id: string): Promise<FileRecord | null> {
      const row = await db.first<FileRow>("SELECT * FROM file_meta_files WHERE id = ?", id);
      return row ? toRecord(row) : null;
    },

    async getByDriveFileId(driveFileId: string): Promise<FileRecord | null> {
      const row = await db.first<FileRow>("SELECT * FROM file_meta_files WHERE drive_file_id = ?", driveFileId);
      return row ? toRecord(row) : null;
    },

    async updateFile(id: string, patch: UpdateFilePatch, updatedAt: string): Promise<FileRecord | null> {
      const sets: string[] = [];
      const binds: unknown[] = [];
      if (patch.name !== undefined) { sets.push("name = ?"); binds.push(patch.name); }
      if (patch.visibility !== undefined) { sets.push("visibility = ?"); binds.push(patch.visibility); }
      if (patch.ownerId !== undefined) { sets.push("owner_id = ?"); binds.push(patch.ownerId); }
      sets.push("updated_at = ?"); binds.push(updatedAt);
      binds.push(id);
      await db.run(`UPDATE file_meta_files SET ${sets.join(", ")} WHERE id = ?`, ...binds);
      return this.getFile(id);
    },

    async softDeleteFile(id: string, archivedAt: string): Promise<boolean> {
      const res = await db.run("UPDATE file_meta_files SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL", archivedAt, archivedAt, id);
      return res.meta.changes > 0;
    },

    async softDeleteByDriveFileId(driveFileId: string, archivedAt: string): Promise<boolean> {
      const res = await db.run("UPDATE file_meta_files SET archived_at = ?, updated_at = ? WHERE drive_file_id = ? AND archived_at IS NULL", archivedAt, archivedAt, driveFileId);
      return res.meta.changes > 0;
    },

    async search(filter: SearchFilter): Promise<{ items: FileRecord[]; nextCursor: string | null }> {
      const where: string[] = [];
      const binds: unknown[] = [];
      if (!filter.includeArchived) where.push("archived_at IS NULL");
      if (filter.q) { where.push("name LIKE ?"); binds.push(`%${filter.q}%`); }
      if (filter.mimeType) { where.push("mime_type = ?"); binds.push(filter.mimeType); }
      if (filter.ownerId) { where.push("owner_id = ?"); binds.push(filter.ownerId); }
      if (filter.cursor) { where.push("id > ?"); binds.push(decodeCursor(filter.cursor)); }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const rows = await db.all<FileRow>(`SELECT * FROM file_meta_files ${clause} ORDER BY id ASC LIMIT ?`, ...binds, filter.limit + 1);
      const items = rows.slice(0, filter.limit).map(toRecord);
      const nextCursor = rows.length > filter.limit ? encodeCursor(items[items.length - 1]!.id) : null;
      return { items, nextCursor };
    },

    async listLinks(fileId: string): Promise<fileMeta.FileMetaLink[]> {
      const rows = await db.all<LinkRow>("SELECT * FROM file_meta_links WHERE file_id = ? AND archived_at IS NULL ORDER BY linked_at ASC", fileId);
      return rows.map((r) => ({
        fileId: r.file_id,
        targetType: r.target_type as fileMeta.FileLinkTargetType,
        targetId: r.target_id,
        linkedAt: r.linked_at,
      }));
    },

    async addLink(link: StoredLink): Promise<{ created: boolean }> {
      const existing = await db.first<{ file_id: string }>(
        "SELECT file_id FROM file_meta_links WHERE file_id = ? AND target_type = ? AND target_id = ?",
        link.fileId, link.targetType, link.targetId,
      );
      if (existing) return { created: false };
      await db.run(
        "INSERT INTO file_meta_links (file_id, target_type, target_id, linked_by, linked_at, archived_at) VALUES (?, ?, ?, ?, ?, NULL)",
        link.fileId, link.targetType, link.targetId, link.linkedBy, link.linkedAt,
      );
      return { created: true };
    },

    async removeLink(fileId: string, targetType: string, targetId: string): Promise<{ removed: boolean }> {
      const res = await db.run("DELETE FROM file_meta_links WHERE file_id = ? AND target_type = ? AND target_id = ?", fileId, targetType, targetId);
      return { removed: res.meta.changes > 0 };
    },

    async suppressLinksByTarget(targetType: string, targetId: string, archivedAt: string): Promise<number> {
      const res = await db.run("UPDATE file_meta_links SET archived_at = ? WHERE target_type = ? AND target_id = ? AND archived_at IS NULL", archivedAt, targetType, targetId);
      return res.meta.changes;
    },
  };
}

/** D1-backed idempotency ledger for the Queue consumer (envelope.id). */
export function createD1IdempotencyStore(db: DbClient): IdempotencyStore {
  return {
    async wasProcessed(eventId: string): Promise<boolean> {
      const row = await db.first<{ event_id: string }>("SELECT event_id FROM file_meta_processed_events WHERE event_id = ?", eventId);
      return row !== null;
    },
    async markProcessed(eventId: string): Promise<void> {
      await db.run("INSERT OR IGNORE INTO file_meta_processed_events (event_id, processed_at) VALUES (?, ?)", eventId, nowIso());
    },
  };
}
