// Orchestration: cache + soft-rate-limit + Google adapter + event/audit publishing.
// Routes stay thin (parse/authz) and delegate business flow here. Cache hits never
// consume the rate budget (§2-2). Write ops purge affected keys, then publish.
import { errors } from "@dub/errors";
import type { drive } from "@dub/types";
import type { Cache } from "./cache";
import { fileKey, listKey, listPrefix, sheetKey, sheetPrefix, hashParams } from "./cache";
import type { RateLimiter } from "./ratelimit";
import type { GoogleDriveApi } from "./google/client";
import type { GoogleFileResource } from "./google/mapper";
import { toDriveFile, kindOf, embedUrlFor } from "./google/mapper";
import type { EventPublisher, PublishContext } from "./events";
import type { DriveConfig } from "./env";
import type { DriveFileKind, QuotaStatusResponse, WriteSheetValuesResponse } from "./types";

export interface DriveServiceDeps {
  google: GoogleDriveApi;
  cache: Cache;
  rate: RateLimiter;
  events: EventPublisher;
  config: DriveConfig;
}

const VALID_KINDS: ReadonlySet<string> = new Set([
  "doc", "sheet", "slide", "form", "folder", "pdf", "image", "other",
]);
const A1_RANGE = /^(?:'[^']+'|[^!'"]+)?!?[A-Za-z]+\d*(?::[A-Za-z]+\d*)?$/;

const KIND_TO_MIME: Partial<Record<DriveFileKind, string>> = {
  doc: "application/vnd.google-apps.document",
  sheet: "application/vnd.google-apps.spreadsheet",
  slide: "application/vnd.google-apps.presentation",
  form: "application/vnd.google-apps.form",
  folder: "application/vnd.google-apps.folder",
  pdf: "application/pdf",
};

export interface ListArgs {
  folderId?: string;
  cursor?: string;
  limit?: number;
  kind?: string;
  q?: string;
}

export function createDriveService(deps: DriveServiceDeps) {
  const { google, cache, rate, events, config } = deps;

  async function getRaw(id: string): Promise<GoogleFileResource> {
    const cached = await cache.get<GoogleFileResource>(fileKey(id));
    if (cached) return cached;
    await rate.acquire();
    const raw = await google.getFile(id);
    await cache.set(fileKey(id), raw, config.fileTtlSeconds);
    return raw;
  }

  return {
    async list(args: ListArgs): Promise<drive.ListFilesResponse> {
      if (!args.folderId) {
        throw errors.validationFailed([{ field: "folderId", reason: "required" }]);
      }
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) {
        throw errors.validationFailed([{ field: "limit", reason: "out_of_range", message: "1..100" }]);
      }
      if (args.kind !== undefined && !VALID_KINDS.has(args.kind)) {
        throw errors.validationFailed([{ field: "kind", reason: "invalid" }]);
      }
      const pageSize = args.limit ?? 50;
      const key = listKey(args.folderId, hashParams([args.cursor, pageSize, args.kind, args.q]));
      const cached = await cache.get<drive.ListFilesResponse>(key);
      if (cached) return cached;

      await rate.acquire();
      const mime = args.kind ? KIND_TO_MIME[args.kind as DriveFileKind] : undefined;
      const params: Parameters<GoogleDriveApi["listFiles"]>[0] = { folderId: args.folderId, pageSize };
      if (args.cursor) params.pageToken = args.cursor;
      if (mime) params.kind = mime;
      if (args.q) params.q = args.q;
      const { files, nextPageToken } = await google.listFiles(params);
      const res: drive.ListFilesResponse = { items: files.map(toDriveFile), nextCursor: nextPageToken };
      await cache.set(key, res, config.listTtlSeconds);
      return res;
    },

    async get(id: string): Promise<drive.DriveFile> {
      return toDriveFile(await getRaw(id));
    },

    async embed(id: string): Promise<drive.GetEmbedResponse> {
      const raw = await getRaw(id);
      const kind = kindOf(raw.mimeType);
      return { embedUrl: embedUrlFor(id, kind) }; // throws VALIDATION_FAILED for folders
    },

    async create(
      ctx: PublishContext,
      body: { name: string; mimeType: string; parentId?: string; templateFileId?: string },
    ): Promise<drive.DriveFile> {
      if (!body.name || !body.mimeType) {
        throw errors.validationFailed([{ field: !body.name ? "name" : "mimeType", reason: "required" }]);
      }
      await rate.acquire();
      const created = body.templateFileId
        ? await google.copyFile(body.templateFileId, { name: body.name, ...(body.parentId ? { parentId: body.parentId } : {}) })
        : await google.createFile({ name: body.name, mimeType: body.mimeType, ...(body.parentId ? { parentId: body.parentId } : {}) });
      if (body.parentId) await cache.deleteByPrefix(listPrefix(body.parentId));
      await events.fileCreated(ctx, created.id);
      await events.audit(ctx, "drive.file.create", created.id, { name: created.name, kind: kindOf(created.mimeType) });
      return toDriveFile(created);
    },

    async move(ctx: PublishContext, id: string, newParentId: string): Promise<drive.DriveFile> {
      if (!newParentId) throw errors.validationFailed([{ field: "newParentId", reason: "required" }]);
      await rate.acquire();
      const current = await google.getFile(id);
      if (current.trashed) throw errors.notFound("driveFile", id);
      const oldParents = current.parents ?? [];
      await rate.acquire();
      const moved = await google.moveFile(id, newParentId, oldParents);
      await cache.delete(fileKey(id));
      await Promise.all(oldParents.map((p) => cache.deleteByPrefix(listPrefix(p))));
      await cache.deleteByPrefix(listPrefix(newParentId));
      await events.fileMoved(ctx, moved.id);
      await events.audit(ctx, "drive.file.move", moved.id, { newParentId });
      return toDriveFile(moved);
    },

    async trash(ctx: PublishContext, id: string): Promise<{ file: drive.DriveFile; alreadyTrashed: boolean }> {
      await rate.acquire();
      const current = await google.getFile(id);
      if (current.trashed) {
        // idempotent re-trash: 200, no re-emit of event/audit (§6, §7).
        return { file: toDriveFile(current), alreadyTrashed: true };
      }
      await rate.acquire();
      const trashed = await google.trashFile(id);
      await cache.delete(fileKey(id));
      await Promise.all((current.parents ?? []).map((p) => cache.deleteByPrefix(listPrefix(p))));
      await events.fileTrashed(ctx, trashed.id);
      await events.audit(ctx, "drive.file.trash", trashed.id);
      return { file: toDriveFile(trashed), alreadyTrashed: false };
    },

    async readSheet(id: string, range: string): Promise<drive.GetSheetValuesResponse> {
      if (!range || !A1_RANGE.test(range)) {
        throw errors.validationFailed([{ field: "range", reason: "invalid_a1_notation" }]);
      }
      const key = sheetKey(id, hashParams([range]));
      const cached = await cache.get<drive.GetSheetValuesResponse>(key);
      if (cached) return cached;
      await rate.acquire();
      const { values } = await google.getSheetValues(id, range);
      // frozen GetSheetValuesResponse.values is string[][]; Sheets FORMATTED_VALUE
      // returns strings by default — coerce defensively.
      const res: drive.GetSheetValuesResponse = {
        values: values.map((row) => row.map((c) => (c == null ? "" : String(c)))),
      };
      await cache.set(key, res, config.sheetTtlSeconds);
      return res;
    },

    async writeSheet(
      ctx: PublishContext,
      id: string,
      body: { mode: "update" | "append"; range: string; values: (string | number | boolean | null)[][] },
    ): Promise<WriteSheetValuesResponse> {
      if (body.mode !== "update" && body.mode !== "append") {
        throw errors.validationFailed([{ field: "mode", reason: "invalid" }]);
      }
      if (!body.range || !A1_RANGE.test(body.range)) {
        throw errors.validationFailed([{ field: "range", reason: "invalid_a1_notation" }]);
      }
      if (!Array.isArray(body.values)) {
        throw errors.validationFailed([{ field: "values", reason: "required" }]);
      }
      await rate.acquire();
      const current = await google.getFile(id);
      if (current.trashed) throw errors.notFound("driveFile", id); // §6: trashed sheets write -> 404
      await rate.acquire();
      const result =
        body.mode === "update"
          ? await google.updateSheetValues(id, body.range, body.values)
          : await google.appendSheetValues(id, body.range, body.values);
      await cache.deleteByPrefix(sheetPrefix(id));
      await cache.delete(fileKey(id));
      // sheet write is audit-only (drive.sheet.written domain event retired, must#2).
      await events.audit(ctx, "drive.sheet.write", id, { mode: body.mode, range: result.updatedRange });
      return { spreadsheetId: id, updatedRange: result.updatedRange, updatedRows: result.updatedRows };
    },

    async quota(): Promise<QuotaStatusResponse> {
      return rate.status();
    },
  };
}

export type DriveService = ReturnType<typeof createDriveService>;
