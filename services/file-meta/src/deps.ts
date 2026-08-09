// file-meta dependency interfaces. Injected so the app/consumer are testable without
// D1 / R2 / Queues / identity. Real implementations are built in index.ts from env.
import type { MiddlewareHandler } from "hono";
import type { auditLog, common, fileMeta, identity } from "@dub/types";
import type { DubEventName, DubEventPayloadMap } from "@dub/events";

// ---- persistence ----
// Internal record = the public FileMeta contract plus service-private state
// (archivedAt, createdBy) that never crosses the wire. toPublic() strips them.
export interface FileRecord extends fileMeta.FileMeta {
  createdBy: common.UserId;
  archivedAt: string | null;
}
export function toPublic(rec: FileRecord): fileMeta.FileMeta {
  return {
    id: rec.id,
    name: rec.name,
    mimeType: rec.mimeType,
    sizeBytes: rec.sizeBytes,
    ownerId: rec.ownerId,
    visibility: rec.visibility,
    driveFileId: rec.driveFileId,
    r2Key: rec.r2Key,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

export interface StoredLink {
  fileId: string;
  targetType: fileMeta.FileLinkTargetType;
  targetId: string;
  linkedBy: string;
  linkedAt: string;
  archivedAt: string | null;
}

export interface CreateFileInput {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  ownerId: common.UserId;
  visibility: fileMeta.FileVisibility;
  driveFileId: string | null;
  r2Key: string | null;
  createdBy: common.UserId;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateFilePatch {
  name?: string;
  visibility?: fileMeta.FileVisibility;
  ownerId?: common.UserId;
}

export interface SearchFilter {
  q?: string;
  mimeType?: string;
  ownerId?: common.UserId;
  limit: number;
  cursor?: string;
  includeArchived?: boolean;
}

export interface FileRepo {
  createFile(input: CreateFileInput): Promise<FileRecord>;
  getFile(id: string): Promise<FileRecord | null>;
  getByDriveFileId(driveFileId: string): Promise<FileRecord | null>;
  updateFile(id: string, patch: UpdateFilePatch, updatedAt: string): Promise<FileRecord | null>;
  softDeleteFile(id: string, archivedAt: string): Promise<boolean>;
  softDeleteByDriveFileId(driveFileId: string, archivedAt: string): Promise<boolean>;
  search(filter: SearchFilter): Promise<{ items: FileRecord[]; nextCursor: string | null }>;

  listLinks(fileId: string): Promise<fileMeta.FileMetaLink[]>;
  addLink(link: StoredLink): Promise<{ created: boolean }>;
  removeLink(fileId: string, targetType: string, targetId: string): Promise<{ removed: boolean }>;
  /** Suppress (archive) links pointing at an entity, keeping the rows. Returns count. */
  suppressLinksByTarget(targetType: string, targetId: string, archivedAt: string): Promise<number>;
}

// ---- R2 attachment body store ----
export interface BlobPutInput {
  key: string;
  body: ArrayBuffer | Uint8Array;
  contentType: string;
}
export interface BlobObject {
  body: ArrayBuffer;
  contentType: string;
  size: number;
}
export interface BlobStore {
  put(input: BlobPutInput): Promise<void>;
  get(key: string): Promise<BlobObject | null>;
  delete(key: string): Promise<void>;
}

// ---- event emit (file.* — P0 has no subscribers, so emit is contract-only) ----
export type EmitEvent = <N extends DubEventName>(
  name: N,
  payload: DubEventPayloadMap[N],
  ctx: { requestId: string; actorId: string | null },
) => Promise<void>;

// ---- audit ----
export type AuditFn = (input: auditLog.AuditRecordInput) => Promise<void>;

// ---- authz gate (wraps @dub/auth-client; test double bypasses identity) ----
export interface AuthGate {
  requireAuth(): MiddlewareHandler;
  requirePermission(permission: identity.PermissionKey): MiddlewareHandler;
  hasPermission(userId: common.UserId, permission: identity.PermissionKey): Promise<boolean>;
}

// ---- drive-proxy meta completion (optional; failure falls back to caller values) ----
export interface DriveMeta {
  name: string;
  mimeType: string;
}
export interface DriveClient {
  getFile(driveFileId: string): Promise<DriveMeta | null>;
}

export interface FileMetaConfig {
  maxUploadBytes: number; // R2 upload cap (design #1: 25MB), gateway body cap must be >=
}
export const DEFAULT_CONFIG: FileMetaConfig = {
  maxUploadBytes: 25 * 1024 * 1024,
};
