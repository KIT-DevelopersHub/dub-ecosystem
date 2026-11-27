// Shared sending addresses (共用アドレス, 0027). Effective paths through api-gateway:
//   GET    /api/v1/mail/send-as                       the Froms the caller may pick in compose
//   GET    /api/v1/mail/admin/shared-mailboxes        settings (mail:admin)
//   POST   /api/v1/mail/admin/shared-mailboxes
//   PATCH  /api/v1/mail/admin/shared-mailboxes/:id
//   DELETE /api/v1/mail/admin/shared-mailboxes/:id
// AUTHZ lives in src/policy-table.ts. Unlike a team list, a shared mailbox adds no Email
// Routing rule: the address must already reach this Worker (info@ does).
import type { Context, Hono } from "hono";
import { DubError } from "@dub/errors";
import { nowIso, ulid } from "@dub/db";
import { mail } from "@dub/types";
import { buildDb } from "./deps";
import type { AppBindings } from "./env";
import { audited } from "./email-routing-routes";
import { DEFAULT_ARCHIVE_CC_ADDRESS } from "./config";
import { parseIssueAddressRequest } from "./email-routing-validation";
import { COMPANY_MAIL_DOMAIN, resolveUserFromAddress } from "./from";
import { findActiveTeamList } from "./team-list";
import {
  findActiveSharedMailbox,
  listActiveSharedMailboxes,
  listSendableMailboxes,
  memberMaySend,
  SHARED_MAILBOX_COLUMNS,
  toSharedMailboxDto,
  type SharedMailboxRow,
} from "./shared-mailbox";

function invalid(message: string): DubError {
  return new DubError("MAIL_INVALID_REQUEST", message, { status: 400 });
}

/** displayName / signature / allow / teamId. `partial` = PATCH (each field optional). */
function parseSettings(body: unknown, partial: boolean): Partial<mail.MailSharedMailboxInput> {
  if (!body || typeof body !== "object") throw invalid("request body must be a JSON object");
  const b = body as Record<string, unknown>;
  const out: Partial<mail.MailSharedMailboxInput> = {};
  if (b.displayName !== undefined || !partial) {
    const v = typeof b.displayName === "string" ? b.displayName.replace(/[\r\n]+/g, " ").trim() : "";
    if (!v || v.length > mail.MAIL_SHARED_DISPLAY_NAME_MAX) throw invalid(`displayName: 1..${mail.MAIL_SHARED_DISPLAY_NAME_MAX} chars`);
    out.displayName = v;
  }
  if (b.signature !== undefined || !partial) {
    const v = b.signature ?? "";
    if (typeof v !== "string" || v.length > mail.MAIL_SHARED_SIGNATURE_MAX) throw invalid(`signature: <= ${mail.MAIL_SHARED_SIGNATURE_MAX} chars`);
    out.signature = v;
  }
  if (b.allow !== undefined || !partial) {
    if (b.allow !== "all_members" && b.allow !== "team") throw invalid('allow must be "all_members" or "team"');
    out.allow = b.allow;
  }
  if (b.teamId !== undefined) {
    if (b.teamId !== null && (typeof b.teamId !== "string" || !b.teamId.trim() || b.teamId.length > 128)) throw invalid("teamId must be a team id or null");
    out.teamId = typeof b.teamId === "string" ? b.teamId.trim() : null;
  }
  return out;
}

export function registerSharedMailboxes(ext: Hono<AppBindings>): void {
  const dbOf = (c: Context<AppBindings>) => buildDb(c.env, c.get("dubCtx").requestId);

  // The caller's own address first (the compose default), then each shared mailbox and team
  // mailing list they may send as (memberMaySend). A member-service failure only hides the shared ones.
  ext.get("/send-as", async (c) => {
    const ctx = c.get("dubCtx");
    const userId = c.get("userId") ?? null;
    const own = await resolveUserFromAddress(c.env, ctx, userId);
    const items: mail.MailSendAsOption[] = [{ address: own.trim().toLowerCase(), kind: "self" }];
    if (userId) {
      for (const row of await listSendableMailboxes(dbOf(c), c.env.SVC_MEMBER, ctx)) {
        if (row.address === items[0]!.address) continue;
        const allowed = await memberMaySend(c.env.SVC_MEMBER, ctx, row, userId, c.env.SVC_IDENTITY).catch(() => false);
        if (allowed) {
          items.push({
            address: row.address,
            kind: row.team_list ? "team_list" : "shared",
            ...(row.display_name ? { displayName: row.display_name } : {}),
            ...(row.signature ? { signature: row.signature } : {}),
          });
        }
      }
    }
    return c.json({ items } satisfies mail.MailSendAsList);
  });

  ext.get("/admin/shared-mailboxes", async (c) => {
    const rows = await listActiveSharedMailboxes(dbOf(c));
    return c.json({ items: rows.map(toSharedMailboxDto) });
  });

  ext.post("/admin/shared-mailboxes", async (c) => {
    const body = await c.req.json().catch(() => null);
    const { address } = parseIssueAddressRequest(body, c.env.CF_EMAIL_ROUTING_ZONE_NAME || COMPANY_MAIL_DOMAIN);
    const settings = parseSettings(body, false) as mail.MailSharedMailboxInput;
    if (settings.allow === "team" && !settings.teamId) throw invalid("teamId is required when allow is team");
    const db = dbOf(c);
    const conflict = new DubError("MAIL_EMAIL_ROUTING_CONFLICT", `address already in use: ${address}`, { status: 409 });
    // The archive and a team list already have a job; a shared From there would mix them up.
    if (address === (c.env.MAIL_ARCHIVE_CC ?? DEFAULT_ARCHIVE_CC_ADDRESS).trim().toLowerCase()) throw conflict;
    if (await findActiveTeamList(db, address)) throw conflict;
    if (await findActiveSharedMailbox(db, address)) throw conflict;
    const now = nowIso();
    const row: SharedMailboxRow = {
      id: `mailshared_${ulid()}`,
      address,
      display_name: settings.displayName,
      signature: settings.signature,
      allow: settings.allow,
      team_id: settings.allow === "team" ? (settings.teamId ?? null) : null,
      updated_at: now,
    };
    await audited(c, "mail.shared_mailbox.create", "mail_shared_mailbox", address, async () => {
      const res = await db.run(
        `INSERT OR IGNORE INTO mail_shared_mailbox (id, address, display_name, signature, allow, team_id, created_by, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        row.id,
        row.address,
        row.display_name,
        row.signature,
        row.allow,
        row.team_id,
        c.get("userId") ?? null,
        now,
        now,
      );
      if (res.meta.changes === 0) throw conflict;
    });
    return c.json(toSharedMailboxDto(row), 201);
  });

  ext.patch("/admin/shared-mailboxes/:id", async (c) => {
    const id = c.req.param("id");
    const db = dbOf(c);
    const cur = await db.first<SharedMailboxRow>(`SELECT ${SHARED_MAILBOX_COLUMNS} FROM mail_shared_mailbox WHERE id = ? AND deleted_at IS NULL`, id);
    if (!cur) throw new DubError("MAIL_MESSAGE_NOT_FOUND", `shared mailbox not found: ${id}`, { status: 404 });
    const p = parseSettings(await c.req.json().catch(() => null), true);
    const allow = p.allow ?? cur.allow;
    const teamId = allow === "team" ? (p.teamId !== undefined ? p.teamId : cur.team_id) : null;
    if (allow === "team" && !teamId) throw invalid("teamId is required when allow is team");
    const next: SharedMailboxRow = {
      ...cur,
      display_name: p.displayName ?? cur.display_name,
      signature: p.signature ?? cur.signature,
      allow,
      team_id: teamId,
      updated_at: nowIso(),
    };
    await audited(c, "mail.shared_mailbox.update", "mail_shared_mailbox", cur.address, () =>
      db.run(
        `UPDATE mail_shared_mailbox SET display_name = ?, signature = ?, allow = ?, team_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
        next.display_name,
        next.signature,
        next.allow,
        next.team_id,
        next.updated_at,
        id,
      ),
    );
    return c.json(toSharedMailboxDto(next));
  });

  ext.delete("/admin/shared-mailboxes/:id", async (c) => {
    const id = c.req.param("id");
    const db = dbOf(c);
    const cur = await db.first<SharedMailboxRow>(`SELECT ${SHARED_MAILBOX_COLUMNS} FROM mail_shared_mailbox WHERE id = ? AND deleted_at IS NULL`, id);
    if (!cur) throw new DubError("MAIL_MESSAGE_NOT_FOUND", `shared mailbox not found: ${id}`, { status: 404 });
    const now = nowIso();
    await audited(c, "mail.shared_mailbox.delete", "mail_shared_mailbox", cur.address, () =>
      db.run(`UPDATE mail_shared_mailbox SET deleted_at = ?, updated_at = ? WHERE id = ?`, now, now, id),
    );
    return c.json({ id });
  });
}
