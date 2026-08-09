// file-meta-service Hono app (#9). Metadata + link registry (source of truth) + R2
// attachment I/O. Mounted by api-gateway at /api/v1/files/* (stripPrefix=API_PREFIX
// only) so internal paths start at /files. Deps injected (see deps.ts).
import { Hono, type Context } from "hono";
import { DubError, CommonErrorCodes, dubErrorHandler } from "@dub/errors";
import { dubContext, DUB_HEADERS } from "@dub/http";
import { CONTRACT_VERSION, common, type fileMeta } from "@dub/types";
import { newId, nowIso } from "@dub/db";
import {
  type AuditFn,
  type AuthGate,
  type BlobStore,
  type DriveClient,
  type EmitEvent,
  type FileMetaConfig,
  type FileRecord,
  type FileRepo,
  type StoredLink,
  DEFAULT_CONFIG,
  toPublic,
} from "./deps";
import { isFileId, parseLimit, validateLink, validateRegister, validateUpdate } from "./validate";

export interface AppDeps {
  repo: FileRepo;
  blobs: BlobStore;
  emit: EmitEvent;
  audit: AuditFn;
  auth: AuthGate;
  drive?: DriveClient;
  config?: Partial<FileMetaConfig>;
}

interface DubCtx {
  requestId: string;
}

function ctxOf(c: Context): DubCtx {
  return (c.get("dubCtx") as DubCtx | undefined) ?? { requestId: c.req.header(DUB_HEADERS.requestId) ?? "" };
}
function userIdOf(c: Context): string {
  const authn = c.get("authn") as { userId?: string } | undefined;
  if (!authn?.userId) throw new DubError("AUTH_INVALID_TOKEN", "authn context missing", { status: 401 });
  return authn.userId;
}

export function createApp(deps: AppDeps) {
  const cfg: FileMetaConfig = { ...DEFAULT_CONFIG, ...deps.config };
  const { repo, blobs, emit, audit, auth, drive } = deps;
  const app = new Hono();
  app.onError(dubErrorHandler({ service: "file-meta" }));
  app.use("*", dubContext({ allowGenerate: true }));

  const recordAudit = (c: Context, action: string, resourceId: string | null, result: "success" | "failure" = "success", details: Record<string, unknown> | null = null): Promise<void> =>
    audit({
      action,
      actorId: (c.get("authn") as { userId?: string } | undefined)?.userId ?? null,
      orgId: common.DUB_DEFAULT_ORG_ID,
      result,
      resourceType: "file",
      resourceId,
      details,
      requestId: ctxOf(c).requestId,
      occurredAt: nowIso(),
    });

  const emitFor = (c: Context) => {
    const uid = (c.get("authn") as { userId?: string } | undefined)?.userId ?? null;
    return { requestId: ctxOf(c).requestId, actorId: uid };
  };

  // Enforce private-visibility read: owner or file:admin only.
  const assertCanRead = async (c: Context, file: FileRecord): Promise<void> => {
    if (file.visibility !== "private") return; // org files: file:read (middleware) is enough
    const uid = userIdOf(c);
    if (file.ownerId === uid) return;
    if (await auth.hasPermission(uid, "file:admin")) return;
    throw new DubError(CommonErrorCodes.FORBIDDEN, "private file", { status: 403 });
  };

  // ---- health (binding-direct; gateway does not expose /internal/*) ----
  app.get("/internal/health", (c) => {
    c.header("x-dub-contract-version", CONTRACT_VERSION);
    return c.json({ status: "ok", service: "file-meta", contractVersion: CONTRACT_VERSION });
  });

  app.use("/files/*", auth.requireAuth());

  // ---- register meta (source=drive manual/complement, or pre-uploaded r2 key) ----
  app.post("/files/meta", auth.requirePermission("file:write"), async (c) => {
    const body = await c.req.json<fileMeta.RegisterMetaRequest>().catch(() => ({}) as fileMeta.RegisterMetaRequest);
    const v = validateRegister(body);

    // duplicate external id -> 409
    if (v.driveFileId && (await repo.getByDriveFileId(v.driveFileId))) {
      throw new DubError("FILE_DUPLICATE_EXTERNAL", "drive file already registered", { status: 409 });
    }

    // optional drive-proxy completion (name/mime) when source=drive
    let name = v.name;
    let mimeType = v.mimeType;
    if (v.driveFileId && drive) {
      const meta = await drive.getFile(v.driveFileId).catch(() => null);
      if (meta) {
        name = name || meta.name;
        mimeType = meta.mimeType || mimeType;
      }
    }

    const now = nowIso();
    const uid = userIdOf(c);
    const file = await repo.createFile({
      id: newId("file"),
      name,
      mimeType,
      sizeBytes: v.sizeBytes,
      ownerId: uid,
      visibility: v.visibility,
      driveFileId: v.driveFileId,
      r2Key: v.r2Key,
      createdBy: uid,
      createdAt: now,
      updatedAt: now,
    });
    await emit("file.registered", { fileId: file.id }, emitFor(c));
    await recordAudit(c, "file.meta.registered", file.id);
    return c.json<fileMeta.FileMeta>(toPublic(file), 201);
  });

  // ---- search (literal path: registered before /files/:id/download) ----
  app.get("/files/search", auth.requirePermission("file:read"), async (c) => {
    const q = c.req.query("q");
    const mimeType = c.req.query("mimeType");
    const ownerId = c.req.query("ownerId");
    const limit = parseLimit(c.req.query("limit"));
    const cursor = c.req.query("cursor");
    const { items, nextCursor } = await repo.search({
      ...(q ? { q } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(ownerId ? { ownerId } : {}),
      limit,
      ...(cursor ? { cursor } : {}),
    });
    // hide private files the caller cannot read
    const uid = userIdOf(c);
    const admin = items.some((f) => f.visibility === "private" && f.ownerId !== uid)
      ? await auth.hasPermission(uid, "file:admin")
      : false;
    const visible = items.filter((f) => f.visibility !== "private" || f.ownerId === uid || admin);
    return c.json<fileMeta.FileSearchResponse>({ items: visible.map(toPublic), nextCursor });
  });

  // ---- get single meta (?include=links) ----
  app.get("/files/meta/:id", auth.requirePermission("file:read"), async (c) => {
    const id = c.req.param("id");
    if (!isFileId(id)) throw new DubError(CommonErrorCodes.NOT_FOUND, "file not found", { status: 404 });
    const file = await repo.getFile(id);
    if (!file) throw new DubError(CommonErrorCodes.NOT_FOUND, "file not found", { status: 404 });
    await assertCanRead(c, file);
    const include = (c.req.query("include") ?? "").split(",").map((s) => s.trim());
    if (include.includes("links")) {
      const links = await repo.listLinks(id);
      return c.json({ file: toPublic(file), links });
    }
    return c.json({ file: toPublic(file) });
  });

  // ---- update meta ----
  app.patch("/files/meta/:id", auth.requirePermission("file:write"), async (c) => {
    const id = c.req.param("id");
    if (!isFileId(id)) throw new DubError(CommonErrorCodes.NOT_FOUND, "file not found", { status: 404 });
    const existing = await repo.getFile(id);
    if (!existing) throw new DubError(CommonErrorCodes.NOT_FOUND, "file not found", { status: 404 });
    if (existing.archivedAt) throw new DubError("FILE_DELETED_IMMUTABLE", "file is deleted", { status: 409 });
    const patch = validateUpdate(await c.req.json<Record<string, unknown>>().catch(() => ({})));
    // ownerId change is file:admin only
    if (patch.ownerId !== undefined && patch.ownerId !== existing.ownerId) {
      if (!(await auth.hasPermission(userIdOf(c), "file:admin"))) {
        throw new DubError(CommonErrorCodes.FORBIDDEN, "owner change requires file:admin", { status: 403 });
      }
    }
    const updated = await repo.updateFile(id, patch, nowIso());
    if (!updated) throw new DubError(CommonErrorCodes.NOT_FOUND, "file not found", { status: 404 });
    await emit("file.updated", { fileId: id }, emitFor(c));
    await recordAudit(c, "file.meta.updated", id, "success", { changed: Object.keys(patch) });
    return c.json<fileMeta.FileMeta>(toPublic(updated));
  });

  // ---- logical delete ----
  app.delete("/files/meta/:id", auth.requirePermission("file:write"), async (c) => {
    const id = c.req.param("id");
    if (!isFileId(id)) throw new DubError(CommonErrorCodes.NOT_FOUND, "file not found", { status: 404 });
    const existing = await repo.getFile(id);
    if (!existing) throw new DubError(CommonErrorCodes.NOT_FOUND, "file not found", { status: 404 });
    if (existing.archivedAt) return c.body(null, 204); // idempotent
    await repo.softDeleteFile(id, nowIso());
    await emit("file.deleted", { fileId: id }, emitFor(c));
    await recordAudit(c, "file.meta.deleted", id);
    return c.body(null, 204);
  });

  // ---- link add ----
  app.post("/files/meta/:id/links", auth.requirePermission("file:write"), async (c) => {
    const id = c.req.param("id");
    if (!isFileId(id)) throw new DubError(CommonErrorCodes.NOT_FOUND, "file not found", { status: 404 });
    const existing = await repo.getFile(id);
    if (!existing) throw new DubError(CommonErrorCodes.NOT_FOUND, "file not found", { status: 404 });
    if (existing.archivedAt) throw new DubError("FILE_DELETED_IMMUTABLE", "file is deleted", { status: 409 });
    const { targetType, targetId } = validateLink(await c.req.json<Record<string, unknown>>().catch(() => ({})));
    const link: StoredLink = { fileId: id, targetType, targetId, linkedBy: userIdOf(c), linkedAt: nowIso(), archivedAt: null };
    const { created } = await repo.addLink(link);
    if (!created) throw new DubError("FILE_DUPLICATE_LINK", "link already exists", { status: 409 });
    await emit("file.linked", { fileId: id, targetType, targetId }, emitFor(c));
    await recordAudit(c, "file.link.added", id, "success", { targetType, targetId });
    const out: fileMeta.FileMetaLink = { fileId: id, targetType, targetId, linkedAt: link.linkedAt };
    return c.json(out, 201);
  });

  // ---- link remove ----
  app.delete("/files/meta/:id/links", auth.requirePermission("file:write"), async (c) => {
    const id = c.req.param("id");
    if (!isFileId(id)) throw new DubError(CommonErrorCodes.NOT_FOUND, "file not found", { status: 404 });
    const { targetType, targetId } = validateLink(await c.req.json<Record<string, unknown>>().catch(() => ({})));
    const { removed } = await repo.removeLink(id, targetType, targetId);
    if (!removed) throw new DubError(CommonErrorCodes.NOT_FOUND, "link not found", { status: 404 });
    await emit("file.unlinked", { fileId: id, targetType, targetId }, emitFor(c));
    await recordAudit(c, "file.link.removed", id, "success", { targetType, targetId });
    return c.body(null, 204);
  });

  // ---- R2 attachment upload (multipart or raw body). success -> meta auto-register ----
  app.post("/files", auth.requirePermission("file:write"), async (c) => {
    const { bytes, filename, contentType } = await readUploadBody(c);
    if (bytes.byteLength > cfg.maxUploadBytes) {
      throw new DubError(CommonErrorCodes.PAYLOAD_TOO_LARGE, `upload exceeds ${cfg.maxUploadBytes} bytes`, { status: 413 });
    }
    const uid = userIdOf(c);
    const id = newId("file");
    const r2Key = `${common.DUB_DEFAULT_ORG_ID}/${id}`;
    await blobs.put({ key: r2Key, body: bytes, contentType });
    const now = nowIso();
    const file = await repo.createFile({
      id,
      name: filename,
      mimeType: contentType,
      sizeBytes: bytes.byteLength,
      ownerId: uid,
      visibility: "org",
      driveFileId: null,
      r2Key,
      createdBy: uid,
      createdAt: now,
      updatedAt: now,
    });
    await emit("file.registered", { fileId: file.id }, emitFor(c));
    await recordAudit(c, "file.attachment.uploaded", file.id, "success", { sizeBytes: bytes.byteLength });
    return c.json<fileMeta.FileMeta>(toPublic(file), 201);
  });

  // ---- R2 attachment download (source=r2 only; drive -> 409 embed redirect) ----
  app.get("/files/:id/download", auth.requirePermission("file:read"), async (c) => {
    const id = c.req.param("id");
    if (!isFileId(id)) throw new DubError(CommonErrorCodes.NOT_FOUND, "file not found", { status: 404 });
    const file = await repo.getFile(id);
    if (!file || file.archivedAt) throw new DubError(CommonErrorCodes.NOT_FOUND, "file not found", { status: 404 });
    await assertCanRead(c, file);
    if (file.driveFileId || !file.r2Key) {
      throw new DubError("FILE_NOT_DOWNLOADABLE", "drive files are served via drive-proxy embed", { status: 409 });
    }
    const obj = await blobs.get(file.r2Key);
    if (!obj) throw new DubError(CommonErrorCodes.NOT_FOUND, "attachment body missing", { status: 404 });
    return new Response(obj.body, {
      status: 200,
      headers: {
        "content-type": obj.contentType,
        "content-length": String(obj.size),
        "content-disposition": `attachment; filename="${encodeURIComponent(file.name)}"`,
      },
    });
  });

  return app;
}

async function readUploadBody(c: Context): Promise<{ bytes: Uint8Array; filename: string; contentType: string }> {
  const ct = c.req.header("content-type") ?? "";
  if (ct.includes("multipart/form-data")) {
    const form = await c.req.formData();
    const raw = form.get("file") as unknown;
    if (raw === null || typeof raw === "string" || typeof (raw as { arrayBuffer?: unknown }).arrayBuffer !== "function") {
      throw new DubError(CommonErrorCodes.VALIDATION_FAILED, "multipart field 'file' required", { status: 400, details: [{ field: "file", reason: "required" }] });
    }
    const f = raw as { arrayBuffer(): Promise<ArrayBuffer>; name?: string; type?: string };
    const buf = new Uint8Array(await f.arrayBuffer());
    return { bytes: buf, filename: f.name || "upload.bin", contentType: f.type || "application/octet-stream" };
  }
  const buf = new Uint8Array(await c.req.arrayBuffer());
  const filename = c.req.header("x-dub-filename") ?? "upload.bin";
  return { bytes: buf, filename, contentType: ct || "application/octet-stream" };
}
