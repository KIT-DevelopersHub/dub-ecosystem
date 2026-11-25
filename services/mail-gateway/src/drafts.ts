// 下書き (0025): a compose in progress, autosaved server-side so it survives closing the window
// and follows the user across devices (Gmail). Mounted on the external /mail surface; AUTHZ is
// in policy-table.ts. Layer 2 here is the owner: every query is keyed on `ownerOf`, there is no
// read_all view of another account's drafts, and the composite PK keeps two accounts' client-
// minted ids apart.
//
// Attachments have their own routes: PUT runs on every autosave, so it must stay small. The
// client uploads each file once and removes it individually; a reopened draft downloads them.
import type { Hono } from "hono";
import { DubError, errors } from "@dub/errors";
import { type DbClient, nowIso } from "@dub/db";
import { common, mail } from "@dub/types";
import type { AppBindings } from "./env";
import { buildBlobs, buildDb } from "./deps";
import { decodeInputAttachment, type MailBlobStore } from "./attachments";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENTS_TOTAL_BYTES } from "./config";
import { newAttachmentId } from "./repo";
import { assertDraftId, parseDraftAttachment, parseDraftInput } from "./validation";

interface DraftRow {
  id: string;
  mode: mail.MailDraftMode;
  to_text: string;
  cc_text: string;
  bcc_text: string;
  subject: string;
  text_body: string;
  in_reply_to: string | null;
  updated_at: string;
}
interface DraftAttachmentRow {
  id: string;
  draft_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  r2_key: string;
}

const toMeta = (r: DraftAttachmentRow): mail.MailAttachment => ({ id: r.id, filename: r.filename, contentType: r.mime_type, sizeBytes: r.size_bytes });

function toDto(r: DraftRow, attachments: DraftAttachmentRow[]): mail.MailDraft {
  return {
    id: r.id,
    mode: r.mode,
    to: r.to_text,
    cc: r.cc_text,
    bcc: r.bcc_text,
    subject: r.subject,
    body: r.text_body,
    ...(r.in_reply_to ? { inReplyTo: r.in_reply_to } : {}),
    updatedAt: r.updated_at,
    attachments: attachments.filter((a) => a.draft_id === r.id).map(toMeta),
  };
}

const attachmentsOf = (db: DbClient, owner: string, draftId?: string): Promise<DraftAttachmentRow[]> =>
  db.all<DraftAttachmentRow>(
    `SELECT id, draft_id, filename, mime_type, size_bytes, r2_key FROM mail_draft_attachments WHERE owner_user_id = ? AND deleted_at IS NULL${draftId ? " AND draft_id = ?" : ""} ORDER BY created_at ASC, id ASC`,
    ...(draftId ? [owner, draftId] : [owner]),
  );

const draftExists = async (db: DbClient, owner: string, id: string): Promise<boolean> =>
  (await db.first(`SELECT 1 AS x FROM mail_drafts WHERE owner_user_id = ? AND id = ? AND deleted_at IS NULL`, owner, id)) !== null;

function requireBlobs(blobs: MailBlobStore | undefined): MailBlobStore {
  if (!blobs) throw new DubError("MAIL_ATTACHMENTS_UNCONFIGURED", "attachment storage not configured", { status: 503 });
  return blobs;
}

const notFound = (what: string): DubError => new DubError("MAIL_MESSAGE_NOT_FOUND", `${what} not found`, { status: 404 });

export function registerDrafts(ext: Hono<AppBindings>): void {
  const dbOf = (c: { env: AppBindings["Bindings"]; get(k: "dubCtx"): { requestId: string } }): DbClient => buildDb(c.env, c.get("dubCtx").requestId);
  const ownerOf = (c: { get(k: "userId"): string | undefined }): string => {
    const owner = c.get("userId");
    if (!owner) throw errors.forbidden("drafts require an authenticated user");
    return owner;
  };

  ext.get("/drafts", async (c) => {
    const owner = ownerOf(c);
    const db = dbOf(c);
    const rows = await db.all<DraftRow>(`SELECT * FROM mail_drafts WHERE owner_user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`, owner, mail.MAIL_DRAFT_LIMIT);
    const files = rows.length > 0 ? await attachmentsOf(db, owner) : [];
    return c.json({ items: rows.map((r) => toDto(r, files)) } satisfies { items: mail.MailDraft[] });
  });

  ext.put("/drafts/:id", async (c) => {
    const owner = ownerOf(c);
    const id = c.req.param("id");
    assertDraftId(id);
    const input = parseDraftInput(await c.req.json().catch(() => null));
    const db = dbOf(c);
    if (!(await draftExists(db, owner, id))) {
      const row = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM mail_drafts WHERE owner_user_id = ? AND deleted_at IS NULL`, owner);
      if (Number(row?.n ?? 0) >= mail.MAIL_DRAFT_LIMIT) throw new DubError("MAIL_INVALID_REQUEST", `at most ${mail.MAIL_DRAFT_LIMIT} drafts`, { status: 409 });
    }
    const now = nowIso();
    await db.run(
      `INSERT INTO mail_drafts (owner_user_id, id, mode, to_text, cc_text, bcc_text, subject, text_body, in_reply_to, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner_user_id, id) DO UPDATE SET
         mode = excluded.mode, to_text = excluded.to_text, cc_text = excluded.cc_text, bcc_text = excluded.bcc_text,
         subject = excluded.subject, text_body = excluded.text_body, in_reply_to = excluded.in_reply_to, updated_at = excluded.updated_at, deleted_at = NULL`,
      owner,
      id,
      input.mode,
      input.to,
      input.cc,
      input.bcc,
      input.subject,
      input.body,
      input.inReplyTo ?? null,
      now,
      now,
    );
    const saved: mail.MailDraft = { ...input, id, updatedAt: now, attachments: (await attachmentsOf(db, owner, id)).map(toMeta) };
    return c.json(saved);
  });

  // Idempotent: discarding a compose that never reached the server is not an error.
  ext.delete("/drafts/:id", async (c) => {
    const owner = ownerOf(c);
    const id = c.req.param("id");
    assertDraftId(id);
    const db = dbOf(c);
    const files = await attachmentsOf(db, owner, id);
    const now = nowIso();
    await db.run(`UPDATE mail_draft_attachments SET deleted_at = ? WHERE owner_user_id = ? AND draft_id = ? AND deleted_at IS NULL`, now, owner, id);
    await db.run(`UPDATE mail_drafts SET deleted_at = ? WHERE owner_user_id = ? AND id = ? AND deleted_at IS NULL`, now, owner, id);
    const blobs = buildBlobs(c.env);
    if (blobs) await Promise.all(files.map((f) => blobs.delete(f.r2_key).catch(() => undefined)));
    return c.json({ id, deleted: true });
  });

  ext.post("/drafts/:id/attachments", async (c) => {
    const owner = ownerOf(c);
    const id = c.req.param("id");
    assertDraftId(id);
    const input = parseDraftAttachment(await c.req.json().catch(() => null));
    const db = dbOf(c);
    if (!(await draftExists(db, owner, id))) throw notFound("draft");
    const item = decodeInputAttachment(input);
    const files = await attachmentsOf(db, owner, id);
    const total = files.reduce((n, f) => n + f.size_bytes, 0) + item.bytes.byteLength;
    if (files.length >= MAX_ATTACHMENTS_PER_MESSAGE || total > MAX_ATTACHMENTS_TOTAL_BYTES) {
      throw new DubError("MAIL_INVALID_REQUEST", "draft attachment limit exceeded", { status: 400 });
    }
    const attId = newAttachmentId();
    const key = `${common.DUB_DEFAULT_ORG_ID}/drafts/${owner}/${id}/${attId}`;
    await requireBlobs(buildBlobs(c.env)).put({ key, body: item.bytes, contentType: item.contentType });
    await db.run(
      `INSERT INTO mail_draft_attachments (id, owner_user_id, draft_id, filename, mime_type, size_bytes, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      attId,
      owner,
      id,
      item.filename,
      item.contentType,
      item.bytes.byteLength,
      key,
      nowIso(),
    );
    return c.json({ id: attId, filename: item.filename, contentType: item.contentType, sizeBytes: item.bytes.byteLength } satisfies mail.MailAttachment, 201);
  });

  const findAttachment = (db: DbClient, owner: string, draftId: string, attId: string): Promise<DraftAttachmentRow | null> =>
    db.first<DraftAttachmentRow>(
      `SELECT id, draft_id, filename, mime_type, size_bytes, r2_key FROM mail_draft_attachments WHERE owner_user_id = ? AND draft_id = ? AND id = ? AND deleted_at IS NULL`,
      owner,
      draftId,
      attId,
    );

  ext.get("/drafts/:id/attachments/:attId", async (c) => {
    const row = await findAttachment(dbOf(c), ownerOf(c), c.req.param("id"), c.req.param("attId"));
    if (!row) throw notFound("draft attachment");
    const obj = await requireBlobs(buildBlobs(c.env)).get(row.r2_key);
    if (!obj) throw notFound("draft attachment body");
    return new Response(obj.body, {
      status: 200,
      headers: {
        "content-type": row.mime_type || obj.contentType,
        "content-length": String(obj.size),
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      },
    });
  });

  ext.delete("/drafts/:id/attachments/:attId", async (c) => {
    const owner = ownerOf(c);
    const db = dbOf(c);
    const row = await findAttachment(db, owner, c.req.param("id"), c.req.param("attId"));
    if (row) {
      await db.run(`UPDATE mail_draft_attachments SET deleted_at = ? WHERE owner_user_id = ? AND id = ?`, nowIso(), owner, row.id);
      await buildBlobs(c.env)?.delete(row.r2_key).catch(() => undefined);
    }
    return c.json({ id: c.req.param("attId"), deleted: true });
  });
}
