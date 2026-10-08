// file-meta-service Hono app (#9). Metadata + link registry (source of truth) + R2
// attachment I/O. Mounted by api-gateway at /api/v1/files/* (stripPrefix=API_PREFIX
// only) so internal paths start at /files. Deps injected (see deps.ts).
//
// AUTHZ — two layers, and both live in known places:
//
//  1. ENTRY LAYER (type-level): `policyGate` is mounted first and derives BOTH authn (the
//     trusted x-dub-user-id header) and the "does this caller hold the key at all" decision
//     from POLICY_TABLE (src/policy-table.ts), which lists every route below. There is no
//     `requireAuth`, no `requirePermission`, and no hand-rolled x-dub-internal check left in
//     this file. Do NOT add one — add the route to the table instead
//     (test/policy-table.test.ts fails if you forget).
//
//  2. INSTANCE LAYER (this file): whether the key applies to THIS row. A static table cannot
//     answer that, because it needs the loaded record or the request body — so private
//     visibility (`assertFileAccess`), the per-result search filter, and the `file:admin`
//     demand on an `ownerId` reassignment are asserted HERE, right where the row already is.
//     See packages/policy-gate/src/gate.ts's "NOT this layer's job" note and
//     docs/policy-coverage-inventory.md §3(d).
import { Hono, type Context } from "hono";
import { DubError, CommonErrorCodes, dubErrorHandler } from "@dub/errors";
import { dubContext, DUB_HEADERS } from "@dub/http";
import { policyGate, type PermissionGranter, type PolicyGateVars } from "@dub/policy-gate";
import { CONTRACT_VERSION, common, type fileMeta, type identity } from "@dub/types";
import { newId, nowIso } from "@dub/db";
import type { DubEventEnvelope } from "@dub/events";
import type { EnvelopeOutcome } from "./consumer";
import { POLICY_TABLE } from "./policy-table";
import {
  type AuditFn,
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
  /** Which of the requested permission keys the caller holds (identity /authz/check). */
  authz: PermissionGranter;
  drive?: DriveClient;
  config?: Partial<FileMetaConfig>;
  // Free-tier consumer entry: processes one inbound event envelope through the same
  // handler map the Queue consumer uses. Wired in on the free deploy so the
  // POST /internal/events-async landing route can drain producers' deferred rows.
  consume?: (env: DubEventEnvelope) => Promise<EnvelopeOutcome>;
}

type Vars = PolicyGateVars;
type AppContext = Context<{ Variables: Vars }>;

interface DubCtx {
  requestId: string;
}

function ctxOf(c: Context): DubCtx {
  return (c.get("dubCtx") as DubCtx | undefined) ?? { requestId: c.req.header(DUB_HEADERS.requestId) ?? "" };
}

/**
 * The acting user, as established by the gate. Every route that calls this is a keyed route
 * in POLICY_TABLE and the gate 401s a keyed route with no actor, so the throw is defense in
 * depth against a future table edit that loosens a rule while a handler still assumes an
 * actor — not a branch reachable today.
 */
function userIdOf(c: AppContext): string {
  const uid = c.get("userId") as string | undefined;
  if (!uid) throw new DubError("AUTH_INVALID_TOKEN", "authenticated actor missing", { status: 401 });
  return uid;
}

/** Actor for audit/emit attribution; null on an INTERNAL route that propagated none. */
function actorOf(c: AppContext): string | null {
  return (c.get("userId") as string | undefined) ?? null;
}

export function createApp(deps: AppDeps): Hono<{ Variables: Vars }> {
  const cfg: FileMetaConfig = { ...DEFAULT_CONFIG, ...deps.config };
  const { repo, blobs, emit, audit, authz, drive, consume } = deps;
  const app = new Hono<{ Variables: Vars }>();
  app.onError(dubErrorHandler({ service: "file-meta" }));

  // The authorization layer. First and only — every route below is gated by POLICY_TABLE.
  app.use("*", policyGate({ service: "file-meta", table: POLICY_TABLE, granted: authz }));
  // Observability context, deliberately AFTER the gate: it performs no authorization, and
  // keeping the gate in first position is the invariant worth protecting. A denied request
  // therefore gets no GENERATED request id, which costs nothing — `dubErrorHandler` reads the
  // inbound x-dub-request-id header directly, and api-gateway always sets it.
  app.use("*", dubContext({ allowGenerate: true }));

  /** Does the caller hold one specific key? The instance layer's only identity question. */
  const holdsKey = async (userId: string, key: identity.PermissionKey): Promise<boolean> =>
    (await authz(userId, common.DUB_DEFAULT_ORG_ID, [key])).includes(key);

  const recordAudit = (c: AppContext, action: string, resourceId: string | null, result: "success" | "failure" = "success", details: Record<string, unknown> | null = null): Promise<void> =>
    audit({
      action,
      actorId: actorOf(c),
      orgId: common.DUB_DEFAULT_ORG_ID,
      result,
      resourceType: "file",
      resourceId,
      details,
      requestId: ctxOf(c).requestId,
      occurredAt: nowIso(),
    });

  const emitFor = (c: AppContext): { requestId: string; actorId: string | null } => ({
    requestId: ctxOf(c).requestId,
    actorId: actorOf(c),
  });

  /**
   * INSTANCE-LEVEL authorization: may this caller act on THIS file? An `org` file is open to
   * anyone the table already let in; a `private` file is reachable only by its owner or a
   * `file:admin`.
   *
   * Applied to EVERY route that acts on one identified file — the reads (where it always
   * was) AND the mutations. The mutations are the fix for inventory §3(d): `DELETE
   * /files/meta/:id` asserted nothing beyond `file:write`, so any writer could logically
   * delete — and PATCH, and relink — a private file it could not even read. That asymmetry
   * is closed here rather than preserved: a file you may not see is a file you may not
   * change.
   */
  const assertFileAccess = async (c: AppContext, file: FileRecord): Promise<void> => {
    if (file.visibility !== "private") return; // org files: the table's file:read/write is enough
    const uid = userIdOf(c);
    if (file.ownerId === uid) return;
    if (await holdsKey(uid, "file:admin")) return;
    throw new DubError(CommonErrorCodes.FORBIDDEN, "private file", { status: 403 });
  };

  /** Load one file by id, or 404 (malformed id included). Shared by the `:id` routes. */
  const loadFile = async (id: string): Promise<FileRecord> => {
    if (!isFileId(id)) throw new DubError(CommonErrorCodes.NOT_FOUND, "file not found", { status: 404 });
    const file = await repo.getFile(id);
    if (!file) throw new DubError(CommonErrorCodes.NOT_FOUND, "file not found", { status: 404 });
    return file;
  };

  // ---- health (INTERNAL in the table: binding-direct, the gateway does not expose /internal/*) ----
  app.get("/internal/health", (c) => {
    c.header("x-dub-contract-version", CONTRACT_VERSION);
    return c.json({ status: "ok", service: "file-meta", contractVersion: CONTRACT_VERSION });
  });

  // ---- async event ingest (free-tier consumer landing; outbox drain target) ----
  // Free-tier replacement for the retired EVT_FILE_META Queue consumer. Producers of
  // drive.* / *.archived (drive-proxy / event / task) that deferred `evt.file-meta`
  // rows in their own @dub/freeq outbox forward each envelope here over their SVC_*
  // binding — the SAME DubEventEnvelope the retired Queue consumer understood, run
  // through the SAME handler map (see createEnvelopeConsumer). The envelope id is the
  // idempotency key (file_meta_processed_events + unique drive_file_id), so at-least-once
  // re-delivery is safe. A non-2xx makes the caller's drain keep its row pending and
  // retry, so an event is never lost.
  //
  // Internal-only via the table's INTERNAL rule, which replaces the inline
  // `if (!c.req.header(HEADERS.internal)) 404` that used to open this handler. The refusal
  // is now the gate's 403 `internal_only` instead of a 404 — still non-2xx, so a caller's
  // drain keeps its row pending exactly as before.
  app.post("/internal/events-async", async (c) => {
    if (!consume) throw new DubError(CommonErrorCodes.INTERNAL, "event consumer not configured", { status: 500 });
    const env = (await c.req.json<DubEventEnvelope>().catch(() => null)) as DubEventEnvelope | null;
    const outcome = await consume(env as DubEventEnvelope);
    if (outcome === "retry") {
      // Non-2xx: the caller's outbox row stays pending and is redelivered (never lost).
      throw new DubError("FILE_EVENT_INGEST_FAILED", "event processing failed; retry", { status: 500 });
    }
    return c.body(null, 202);
  });

  // ---- register meta (source=drive manual/complement, or pre-uploaded r2 key) ----
  app.post("/files/meta", async (c) => {
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
  app.get("/files/search", async (c) => {
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
    // INSTANCE LAYER: hide private files the caller cannot read. At most one identity call,
    // and only when the page actually contains someone else's private row.
    const uid = userIdOf(c);
    const admin = items.some((f) => f.visibility === "private" && f.ownerId !== uid)
      ? await holdsKey(uid, "file:admin")
      : false;
    const visible = items.filter((f) => f.visibility !== "private" || f.ownerId === uid || admin);
    return c.json<fileMeta.FileSearchResponse>({ items: visible.map(toPublic), nextCursor });
  });

  // ---- get single meta (?include=links) ----
  app.get("/files/meta/:id", async (c) => {
    const id = c.req.param("id");
    const file = await loadFile(id);
    await assertFileAccess(c, file);
    const include = (c.req.query("include") ?? "").split(",").map((s) => s.trim());
    if (include.includes("links")) {
      const links = await repo.listLinks(id);
      return c.json({ file: toPublic(file), links });
    }
    return c.json({ file: toPublic(file) });
  });

  // ---- update meta ----
  app.patch("/files/meta/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await loadFile(id);
    await assertFileAccess(c, existing);
    if (existing.archivedAt) throw new DubError("FILE_DELETED_IMMUTABLE", "file is deleted", { status: 409 });
    const patch = validateUpdate(await c.req.json<Record<string, unknown>>().catch(() => ({})));
    // INSTANCE LAYER: an ownerId reassignment is file:admin only. Body-dependent, so it
    // cannot be a table rule — for every other field the same route is an ordinary 編集 write.
    if (patch.ownerId !== undefined && patch.ownerId !== existing.ownerId) {
      if (!(await holdsKey(userIdOf(c), "file:admin"))) {
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
  app.delete("/files/meta/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await loadFile(id);
    // The §3(d) fix. This assertion did not exist: `file:write` alone logically deleted any
    // file, private ones belonging to other people included.
    await assertFileAccess(c, existing);
    if (existing.archivedAt) return c.body(null, 204); // idempotent
    await repo.softDeleteFile(id, nowIso());
    await emit("file.deleted", { fileId: id }, emitFor(c));
    await recordAudit(c, "file.meta.deleted", id);
    return c.body(null, 204);
  });

  // ---- link add ----
  app.post("/files/meta/:id/links", async (c) => {
    const id = c.req.param("id");
    const existing = await loadFile(id);
    await assertFileAccess(c, existing);
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
  // Loads the file (it did not before) only to run the same instance-level check as every
  // other `/files/meta/:id` route: unlinking a private file is a mutation of it. A file that
  // does not exist already answered 404 here via `removeLink`, so the status contract is
  // unchanged. Deliberately NO archivedAt guard — unlinking a deleted file stays allowed.
  app.delete("/files/meta/:id/links", async (c) => {
    const id = c.req.param("id");
    await assertFileAccess(c, await loadFile(id));
    const { targetType, targetId } = validateLink(await c.req.json<Record<string, unknown>>().catch(() => ({})));
    const { removed } = await repo.removeLink(id, targetType, targetId);
    if (!removed) throw new DubError(CommonErrorCodes.NOT_FOUND, "link not found", { status: 404 });
    await emit("file.unlinked", { fileId: id, targetType, targetId }, emitFor(c));
    await recordAudit(c, "file.link.removed", id, "success", { targetType, targetId });
    return c.body(null, 204);
  });

  // ---- R2 attachment upload (multipart or raw body). success -> meta auto-register ----
  app.post("/files", async (c) => {
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
  app.get("/files/:id/download", async (c) => {
    const id = c.req.param("id");
    const file = await loadFile(id);
    if (file.archivedAt) throw new DubError(CommonErrorCodes.NOT_FOUND, "file not found", { status: 404 });
    await assertFileAccess(c, file);
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
