// In-memory test doubles for file-meta (FileRepo, BlobStore, IdempotencyStore, AuthGate)
// plus spy emit/audit. Mirrors the D1 repo semantics closely enough for unit coverage.
import type { MiddlewareHandler } from "hono";
import { DubError, CommonErrorCodes } from "@dub/errors";
import type { IdempotencyStore } from "@dub/events";
import type { fileMeta, identity } from "@dub/types";
import type {
  AuditFn,
  AuthGate,
  BlobObject,
  BlobStore,
  CreateFileInput,
  EmitEvent,
  FileRecord,
  FileRepo,
  SearchFilter,
  StoredLink,
  UpdateFilePatch,
} from "../src/deps";

const enc = (id: string): string => btoa(id);
const dec = (c: string): string => { try { return atob(c); } catch { return ""; } };

export function createMemoryFileRepo(): FileRepo & { _files: Map<string, FileRecord>; _links: StoredLink[] } {
  const files = new Map<string, FileRecord>();
  const links: StoredLink[] = [];

  const repo: FileRepo = {
    async createFile(input: CreateFileInput): Promise<FileRecord> {
      if (input.driveFileId && [...files.values()].some((f) => f.driveFileId === input.driveFileId)) {
        throw new DubError("FILE_DUPLICATE_EXTERNAL", "drive dup", { status: 409 });
      }
      const rec: FileRecord = {
        id: input.id, name: input.name, mimeType: input.mimeType, sizeBytes: input.sizeBytes,
        ownerId: input.ownerId, visibility: input.visibility, driveFileId: input.driveFileId,
        r2Key: input.r2Key, createdBy: input.createdBy, archivedAt: null,
        createdAt: input.createdAt, updatedAt: input.updatedAt,
      };
      files.set(rec.id, rec);
      return { ...rec };
    },
    async getFile(id) { const f = files.get(id); return f ? { ...f } : null; },
    async getByDriveFileId(driveFileId) { return [...files.values()].find((f) => f.driveFileId === driveFileId) ?? null; },
    async updateFile(id, patch: UpdateFilePatch, updatedAt) {
      const f = files.get(id);
      if (!f) return null;
      const next: FileRecord = {
        ...f,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
        ...(patch.ownerId !== undefined ? { ownerId: patch.ownerId } : {}),
        updatedAt,
      };
      files.set(id, next);
      return { ...next };
    },
    async softDeleteFile(id, archivedAt) {
      const f = files.get(id);
      if (!f || f.archivedAt) return false;
      files.set(id, { ...f, archivedAt, updatedAt: archivedAt });
      return true;
    },
    async softDeleteByDriveFileId(driveFileId, archivedAt) {
      const f = [...files.values()].find((x) => x.driveFileId === driveFileId);
      if (!f || f.archivedAt) return false;
      files.set(f.id, { ...f, archivedAt, updatedAt: archivedAt });
      return true;
    },
    async search(filter: SearchFilter) {
      let all = [...files.values()];
      if (!filter.includeArchived) all = all.filter((f) => f.archivedAt === null);
      if (filter.q) all = all.filter((f) => f.name.includes(filter.q!));
      if (filter.mimeType) all = all.filter((f) => f.mimeType === filter.mimeType);
      if (filter.ownerId) all = all.filter((f) => f.ownerId === filter.ownerId);
      all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const after = filter.cursor ? dec(filter.cursor) : "";
      const start = after ? all.findIndex((f) => f.id > after) : 0;
      const slice = start < 0 ? [] : all.slice(start, start + filter.limit + 1);
      const items = slice.slice(0, filter.limit).map((f) => ({ ...f }));
      const nextCursor = slice.length > filter.limit ? enc(items[items.length - 1]!.id) : null;
      return { items, nextCursor };
    },
    async listLinks(fileId): Promise<fileMeta.FileMetaLink[]> {
      return links
        .filter((l) => l.fileId === fileId && l.archivedAt === null)
        .map((l) => ({ fileId: l.fileId, targetType: l.targetType, targetId: l.targetId, linkedAt: l.linkedAt }));
    },
    async addLink(link: StoredLink) {
      if (links.some((l) => l.fileId === link.fileId && l.targetType === link.targetType && l.targetId === link.targetId)) {
        return { created: false };
      }
      links.push({ ...link });
      return { created: true };
    },
    async removeLink(fileId, targetType, targetId) {
      const i = links.findIndex((l) => l.fileId === fileId && l.targetType === targetType && l.targetId === targetId);
      if (i < 0) return { removed: false };
      links.splice(i, 1);
      return { removed: true };
    },
    async suppressLinksByTarget(targetType, targetId, archivedAt) {
      let n = 0;
      for (const l of links) {
        if (l.targetType === targetType && l.targetId === targetId && l.archivedAt === null) {
          l.archivedAt = archivedAt;
          n++;
        }
      }
      return n;
    },
  };

  return Object.assign(repo, { _files: files, _links: links });
}

export function createMemoryBlobStore(): BlobStore & { _blobs: Map<string, BlobObject> } {
  const blobs = new Map<string, BlobObject>();
  const store: BlobStore = {
    async put({ key, body, contentType }) {
      const buf = body instanceof Uint8Array ? body.slice().buffer : body;
      blobs.set(key, { body: buf as ArrayBuffer, contentType, size: (buf as ArrayBuffer).byteLength });
    },
    async get(key) { const b = blobs.get(key); return b ? { ...b } : null; },
    async delete(key) { blobs.delete(key); },
  };
  return Object.assign(store, { _blobs: blobs });
}

export function createMemoryIdempotency(): IdempotencyStore & { _seen: Set<string> } {
  const seen = new Set<string>();
  const store: IdempotencyStore = {
    async wasProcessed(id) { return seen.has(id); },
    async markProcessed(id) { seen.add(id); },
  };
  return Object.assign(store, { _seen: seen });
}

/** Stub auth: x-dub-user-id -> authn; permissions from a per-user grant map. */
export function createStubAuth(grants: Record<string, identity.PermissionKey[]>): AuthGate {
  const has = (userId: string, perm: identity.PermissionKey): boolean => (grants[userId] ?? []).includes(perm);
  return {
    requireAuth(): MiddlewareHandler {
      return async (c, next) => {
        const userId = c.req.header("x-dub-user-id");
        if (!userId) throw new DubError("AUTH_INVALID_TOKEN", "no user", { status: 401 });
        c.set("authn", { userId, source: "trusted_header", session: null });
        await next();
      };
    },
    requirePermission(permission): MiddlewareHandler {
      return async (c, next) => {
        const authn = c.get("authn") as { userId?: string } | undefined;
        if (!authn?.userId) throw new DubError("AUTH_INVALID_TOKEN", "no authn", { status: 401 });
        if (!has(authn.userId, permission)) throw new DubError(CommonErrorCodes.FORBIDDEN, `denied ${permission}`, { status: 403 });
        await next();
      };
    },
    async hasPermission(userId, permission) { return has(userId, permission); },
  };
}

export interface EmitCall { name: string; payload: unknown }
export function createSpyEmit(): { emit: EmitEvent; calls: EmitCall[] } {
  const calls: EmitCall[] = [];
  const emit: EmitEvent = async (name, payload) => { calls.push({ name, payload }); };
  return { emit, calls };
}
export function createSpyAudit(): { audit: AuditFn; calls: unknown[] } {
  const calls: unknown[] = [];
  const audit: AuditFn = async (input) => { calls.push(input); };
  return { audit, calls };
}
