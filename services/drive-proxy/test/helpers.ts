// Shared in-memory fakes for drive-proxy unit tests. No network, no real bindings.
import { errors } from "@dub/errors";
import type { KVNamespace } from "@cloudflare/workers-types";
import type { Cache } from "../src/cache";
import type { RateLimiter } from "../src/ratelimit";
import type { GoogleDriveApi, ListFilesParams, SheetReadResult, SheetWriteResult } from "../src/google/client";
import type { GoogleFileResource } from "../src/google/mapper";
import type { EventPublisher, PublishContext, DriveAuditAction } from "../src/events";
import type { PermissionChecker, DrivePermission } from "../src/permissions";

// ---- in-memory Cache ----
export function memCache(now: () => number = Date.now): Cache & { store: Map<string, { v: string; exp: number }> } {
  const store = new Map<string, { v: string; exp: number }>();
  return {
    store,
    async get<T>(k: string): Promise<T | null> {
      const e = store.get(k);
      if (!e) return null;
      if (e.exp <= now()) {
        store.delete(k);
        return null;
      }
      return JSON.parse(e.v) as T;
    },
    async set<T>(k: string, v: T, ttl: number): Promise<void> {
      store.set(k, { v: JSON.stringify(v), exp: now() + ttl * 1000 });
    },
    async delete(k: string): Promise<void> {
      store.delete(k);
    },
    async deleteByPrefix(p: string): Promise<void> {
      for (const k of [...store.keys()]) if (k.startsWith(p)) store.delete(k);
    },
  };
}

// ---- in-memory RateLimiter ----
export function memRate(softLimit = Number.POSITIVE_INFINITY, windowSeconds = 100): RateLimiter & { used: () => number } {
  let used = 0;
  return {
    async acquire(): Promise<void> {
      if (used >= softLimit) throw errors.rateLimited(windowSeconds);
      used++;
    },
    async status() {
      return { windowSeconds, usedRequests: used, softLimit, throttling: used >= softLimit };
    },
    used: () => used,
  };
}

// ---- recording EventPublisher ----
export interface EventCall {
  t: "created" | "moved" | "trashed" | "audit";
  id?: string;
  action?: DriveAuditAction;
  resourceId?: string;
  details?: Record<string, unknown>;
  ctx: PublishContext;
}
export function memEvents(): EventPublisher & { calls: EventCall[] } {
  const calls: EventCall[] = [];
  return {
    calls,
    async fileCreated(ctx, id) { calls.push({ t: "created", id, ctx }); },
    async fileMoved(ctx, id) { calls.push({ t: "moved", id, ctx }); },
    async fileTrashed(ctx, id) { calls.push({ t: "trashed", id, ctx }); },
    async audit(ctx, action, resourceId, details) { calls.push({ t: "audit", action, resourceId, ...(details ? { details } : {}), ctx }); },
  };
}

// ---- configurable fake Google Drive/Sheets ----
export function memGoogle(seed: GoogleFileResource[] = []) {
  const files = new Map<string, GoogleFileResource>();
  for (const f of seed) files.set(f.id, { ...f });
  const sheets = new Map<string, SheetReadResult["values"]>();
  const calls = { list: 0, get: 0, create: 0, copy: 0, move: 0, trash: 0, sheetRead: 0, sheetUpdate: 0, sheetAppend: 0 };
  let nextPageToken: string | null = null;
  let idSeq = 1000;

  const api: GoogleDriveApi = {
    async listFiles(p: ListFilesParams) {
      calls.list++;
      const items = [...files.values()].filter((f) => !f.trashed && (f.parents ?? []).includes(p.folderId));
      return { files: items, nextPageToken };
    },
    async getFile(id: string): Promise<GoogleFileResource> {
      calls.get++;
      const f = files.get(id);
      if (!f) throw errors.notFound("driveFile", id);
      return { ...f };
    },
    async createFile(meta): Promise<GoogleFileResource> {
      calls.create++;
      const id = `file_${idSeq++}`;
      const f: GoogleFileResource = {
        id, name: meta.name, mimeType: meta.mimeType, modifiedTime: "2026-08-09T00:00:00Z",
        parents: meta.parentId ? [meta.parentId] : [], trashed: false,
      };
      files.set(id, f);
      return { ...f };
    },
    async copyFile(templateId, meta): Promise<GoogleFileResource> {
      calls.copy++;
      const tpl = files.get(templateId);
      const id = `file_${idSeq++}`;
      const f: GoogleFileResource = {
        id, name: meta.name, mimeType: tpl?.mimeType ?? "application/vnd.google-apps.document",
        modifiedTime: "2026-08-09T00:00:00Z", parents: meta.parentId ? [meta.parentId] : [], trashed: false,
      };
      files.set(id, f);
      return { ...f };
    },
    async moveFile(id, newParentId, oldParents): Promise<GoogleFileResource> {
      calls.move++;
      const f = files.get(id)!;
      f.parents = [...(f.parents ?? []).filter((p) => !oldParents.includes(p)), newParentId];
      files.set(id, f);
      return { ...f };
    },
    async trashFile(id): Promise<GoogleFileResource> {
      calls.trash++;
      const f = files.get(id)!;
      f.trashed = true;
      files.set(id, f);
      return { ...f };
    },
    async getSheetValues(spreadsheetId, range): Promise<SheetReadResult> {
      calls.sheetRead++;
      return { range, values: sheets.get(spreadsheetId) ?? [["a", "b"]] };
    },
    async updateSheetValues(spreadsheetId, range, values): Promise<SheetWriteResult> {
      calls.sheetUpdate++;
      sheets.set(spreadsheetId, values);
      return { updatedRange: range, updatedRows: values.length };
    },
    async appendSheetValues(spreadsheetId, range, values): Promise<SheetWriteResult> {
      calls.sheetAppend++;
      const prev = sheets.get(spreadsheetId) ?? [];
      sheets.set(spreadsheetId, [...prev, ...values]);
      return { updatedRange: range, updatedRows: values.length };
    },
  };

  return {
    api,
    calls,
    files,
    sheets,
    setNextPageToken(t: string | null) { nextPageToken = t; },
  };
}

// ---- fake PermissionChecker ----
export function memAuthz(rule: (userId: string, perm: DrivePermission) => boolean): PermissionChecker {
  return { async check(userId, _orgId, permission) { return rule(userId, permission); } };
}

// ---- minimal KVNamespace fake (for KV-backed cache / rate / token tests) ----
export function fakeKV(now: () => number = Date.now): KVNamespace {
  const m = new Map<string, { v: string; exp?: number }>();
  const kv = {
    async get(key: string, type?: unknown): Promise<unknown> {
      const e = m.get(key);
      if (!e) return null;
      if (e.exp && e.exp <= now()) { m.delete(key); return null; }
      return type === "json" ? JSON.parse(e.v) : e.v;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
      m.set(key, { v: value, ...(opts?.expirationTtl ? { exp: now() + opts.expirationTtl * 1000 } : {}) });
    },
    async delete(key: string): Promise<void> { m.delete(key); },
    async list(opts?: { prefix?: string; cursor?: string }): Promise<unknown> {
      const prefix = opts?.prefix ?? "";
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true, cursor: "" };
    },
  };
  return kv as unknown as KVNamespace;
}
