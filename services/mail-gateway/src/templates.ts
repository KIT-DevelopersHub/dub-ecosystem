// 定型文 (0026, #867): a saved subject + body a member inserts when composing. Mounted on the
// external /mail surface; AUTHZ is in policy-table.ts. Layer 2 here is the owner: every query is
// keyed on `ownerOf`, and the composite PK keeps two accounts' client-minted ids apart.
import type { Hono } from "hono";
import { DubError, errors } from "@dub/errors";
import { type DbClient, nowIso } from "@dub/db";
import { mail } from "@dub/types";
import type { AppBindings } from "./env";
import { buildDb } from "./deps";
import { assertDraftId, parseTemplateInput } from "./validation";

interface TemplateRow {
  id: string;
  title: string;
  subject: string;
  text_body: string;
  updated_at: string;
}

const toDto = (r: TemplateRow): mail.MailTemplate => ({ id: r.id, title: r.title, subject: r.subject, body: r.text_body, updatedAt: r.updated_at });

export function registerTemplates(ext: Hono<AppBindings>): void {
  const dbOf = (c: { env: AppBindings["Bindings"]; get(k: "dubCtx"): { requestId: string } }): DbClient => buildDb(c.env, c.get("dubCtx").requestId);
  const ownerOf = (c: { get(k: "userId"): string | undefined }): string => {
    const owner = c.get("userId");
    if (!owner) throw errors.forbidden("templates require an authenticated user");
    return owner;
  };

  ext.get("/templates", async (c) => {
    const rows = await dbOf(c).all<TemplateRow>(
      `SELECT id, title, subject, text_body, updated_at FROM mail_templates WHERE owner_user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id ASC LIMIT ?`,
      ownerOf(c),
      mail.MAIL_TEMPLATE_LIMIT,
    );
    return c.json({ items: rows.map(toDto) } satisfies mail.MailTemplateList);
  });

  // Create or replace (client-minted id, so a save can be shown before the server answers).
  ext.put("/templates/:id", async (c) => {
    const owner = ownerOf(c);
    const id = c.req.param("id");
    assertDraftId(id);
    const input = parseTemplateInput(await c.req.json().catch(() => null));
    const db = dbOf(c);
    const exists = await db.first(`SELECT 1 AS x FROM mail_templates WHERE owner_user_id = ? AND id = ? AND deleted_at IS NULL`, owner, id);
    if (!exists) {
      const row = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM mail_templates WHERE owner_user_id = ? AND deleted_at IS NULL`, owner);
      if (Number(row?.n ?? 0) >= mail.MAIL_TEMPLATE_LIMIT) throw new DubError("MAIL_INVALID_REQUEST", `at most ${mail.MAIL_TEMPLATE_LIMIT} templates`, { status: 409 });
    }
    const now = nowIso();
    await db.run(
      `INSERT INTO mail_templates (owner_user_id, id, title, subject, text_body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner_user_id, id) DO UPDATE SET
         title = excluded.title, subject = excluded.subject, text_body = excluded.text_body, updated_at = excluded.updated_at, deleted_at = NULL`,
      owner,
      id,
      input.title,
      input.subject,
      input.body,
      now,
      now,
    );
    return c.json({ ...input, id, updatedAt: now } satisfies mail.MailTemplate);
  });

  // Idempotent: deleting a template that is already gone is not an error.
  ext.delete("/templates/:id", async (c) => {
    const id = c.req.param("id");
    assertDraftId(id);
    await dbOf(c).run(`UPDATE mail_templates SET deleted_at = ? WHERE owner_user_id = ? AND id = ? AND deleted_at IS NULL`, nowIso(), ownerOf(c), id);
    return c.json({ id, deleted: true });
  });
}
