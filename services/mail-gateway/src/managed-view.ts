// 自分の班・チームのメンバーのメールを読み取り専用で見る (#942). Effective paths through api-gateway:
//   GET /api/v1/mail/managed-mailboxes                                 whose mailbox the caller may open
//   GET /api/v1/mail/managed/:userId/messages | /counts                 that member's inbox (list / badges)
//   GET /api/v1/mail/managed/:userId/messages/:id | /threads/:id        open a message / conversation
//   GET /api/v1/mail/managed/:userId/sent | /sent/:id                   that member's Sent folder
//   GET /api/v1/mail/managed/:userId/{messages,sent}/:id/attachments/:attId
//
// AUTHZ, the 2-layer split (CLAUDE.md §3):
//   1. policy-table.ts: every route needs メール閲覧 + mail:read + mail:read_managed (turned on per
//      role in ロール管理). That only says the caller may use the feature AT ALL.
//   2. here, `assertManaged`: :userId must be one of the members member-service puts in the
//      caller's range — a leader's 班, an organizer's team, nothing wider. Asked fresh on every
//      request (no cache), so a roster change takes effect at once; member-service down = 502,
//      never a guess. Out of range = 403 before any row is read.
// Read-only by construction: only GET routes exist under /managed, so nothing here can send as
// the member, mark their mail read, or change their flags. Opening a message, a conversation, a
// sent mail or an attachment of another member is written to the audit log.
import type { Context, Hono } from "hono";
import { DubError, errors } from "@dub/errors";
import { createServiceClient } from "@dub/http";
import { consoleSink } from "@dub/observability";
import { publishAudit } from "@dub/events";
import { nowIso } from "@dub/db";
import { common, type mail } from "@dub/types";
import type { AppBindings } from "./env";
import { SERVICE_NAME } from "./config";
import { buildAuditEnv, buildBlobs, buildDb } from "./deps";
import { attachmentsFor } from "./attachments";
import { getAttachment, getInboundDetail, getSentDetail, listInbound, listSent, listThread } from "./repo";
import { parseListMessagesQuery } from "./validation";
import { countFolders, listInboundFolder } from "./folders";
import { loadMatcher, markBlocked } from "./blocks";

type C = Context<AppBindings>;

export interface ManagedViewHelpers {
  ownerOf(c: C): string;
  /** Drop the archive auto-CC from a DTO for display (app.ts hideArchiveCc + archiveOf). */
  hideArchive<T extends { cc?: mail.MailAddress[] }>(c: C, item: T): T;
}

export const MANAGED_VIEW_AUDIT_ACTION = "mail.managed_view.open";

/** The members `viewer` may open, straight from member-service (the roster owns 班 / チーム). */
export async function listManagedMailboxes(c: C, viewer: string): Promise<mail.MailManagedMailbox[]> {
  const member = c.env.SVC_MEMBER;
  if (!member) return [];
  try {
    const client = createServiceClient(member, { service: "member-service", caller: SERVICE_NAME });
    const res = await client.get<{ items?: unknown }>(c.get("dubCtx"), `/members/internal/managed-mailboxes?userId=${encodeURIComponent(viewer)}`);
    const items = Array.isArray(res?.items) ? res.items : [];
    return items.filter(
      (i): i is mail.MailManagedMailbox =>
        !!i && typeof i === "object" && typeof (i as mail.MailManagedMailbox).userId === "string" && (i as mail.MailManagedMailbox).userId !== viewer,
    );
  } catch (err) {
    throw errors.upstreamUnavailable("member-service", err);
  }
}

/** Layer 2: :userId is in the caller's range, else 403. Returns the target's userId. */
async function assertManaged(c: C, h: ManagedViewHelpers): Promise<string> {
  const viewer = h.ownerOf(c);
  const target = c.req.param("userId") ?? "";
  const range = await listManagedMailboxes(c, viewer);
  if (!target || !range.some((m) => m.userId === target)) {
    throw errors.forbidden("mailbox is outside the members you manage");
  }
  return target;
}

/** One audit row per opened item. Never masks the response (a publish error is logged). */
async function auditOpen(c: C, resourceType: string, resourceId: string, target: string): Promise<void> {
  const ctx = c.get("dubCtx");
  try {
    await publishAudit(buildAuditEnv(c.env), {
      action: MANAGED_VIEW_AUDIT_ACTION,
      actorId: c.get("userId") ?? null,
      orgId: common.DUB_DEFAULT_ORG_ID,
      result: "success",
      resourceType,
      resourceId,
      details: { targetUserId: target },
      requestId: ctx.requestId,
      occurredAt: nowIso(),
    });
  } catch (err) {
    consoleSink({
      level: "error",
      message: "mail-gateway: failed to publish managed-view audit",
      service: SERVICE_NAME,
      requestId: ctx.requestId,
      fields: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

const notFound = (what: string, id: string): DubError => new DubError("MAIL_MESSAGE_NOT_FOUND", `${what} not found: ${id}`, { status: 404 });

export function registerManagedView(ext: Hono<AppBindings>, h: ManagedViewHelpers): void {
  const dbOf = (c: C) => buildDb(c.env, c.get("dubCtx").requestId);

  ext.get("/managed-mailboxes", async (c) => {
    const items = await listManagedMailboxes(c, h.ownerOf(c));
    return c.json({ items } satisfies mail.MailManagedMailboxList);
  });

  // The member's mailbox as they see it: their own mail only (never what THEY can see through
  // role sharing — the range does not chain), their read state / folders / block list.
  ext.get("/managed/:userId/messages", async (c) => {
    const target = await assertManaged(c, h);
    const q = parseListMessagesQuery(c.req.query());
    const db = dbOf(c);
    if (q.folder !== undefined) {
      const page = await listInboundFolder(db, {
        scope: target,
        viewer: target,
        folder: q.folder,
        limit: q.limit,
        ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
        ...(q.q !== undefined ? { q: q.q } : {}),
        ...(q.withTotal === false ? { withTotal: false } : {}),
      });
      for (const m of page.items) h.hideArchive(c, m);
      markBlocked(page.items, await loadMatcher(db, target));
      return c.json(page satisfies mail.MailMessagePage);
    }
    const page = await listInbound(db, { ...q, ownerUserId: target, viewer: target });
    for (const m of page.items) h.hideArchive(c, m);
    markBlocked(page.items, await loadMatcher(db, target));
    return c.json(page satisfies common.Paginated<mail.MailMessageListItem>);
  });

  ext.get("/managed/:userId/counts", async (c) => {
    const target = await assertManaged(c, h);
    return c.json((await countFolders(dbOf(c), target, target)) satisfies mail.MailFolderCounts);
  });

  ext.get("/managed/:userId/messages/:id", async (c) => {
    const target = await assertManaged(c, h);
    const db = dbOf(c);
    const id = c.req.param("id");
    const msg = await getInboundDetail(db, id, target, target);
    if (!msg) throw notFound("message", id);
    h.hideArchive(c, msg);
    markBlocked([msg], await loadMatcher(db, target));
    const attachments = await attachmentsFor(db, "inbound", msg.id);
    if (attachments.length > 0) msg.attachments = attachments;
    await auditOpen(c, "mail_message", msg.id, target);
    return c.json(msg satisfies mail.MailMessageDetail);
  });

  ext.get("/managed/:userId/threads/:id", async (c) => {
    const target = await assertManaged(c, h);
    const db = dbOf(c);
    const threadId = c.req.param("id");
    const messages = await listThread(db, threadId, target, target);
    if (messages.length === 0) throw notFound("thread", threadId);
    markBlocked(messages, await loadMatcher(db, target));
    for (const m of messages) {
      h.hideArchive(c, m);
      const attachments = await attachmentsFor(db, "inbound", m.id);
      if (attachments.length > 0) m.attachments = attachments;
    }
    await auditOpen(c, "mail_thread", threadId, target);
    return c.json({ id: threadId, messages } satisfies mail.MailThread);
  });

  // Sent: the viewer stays the CALLER, so Bcc (the sender's private knowledge) is never shown —
  // the same rule as mail:read_all oversight.
  ext.get("/managed/:userId/sent", async (c) => {
    const target = await assertManaged(c, h);
    const q = parseListMessagesQuery(c.req.query());
    const page = await listSent(dbOf(c), {
      ownerUserId: target,
      viewer: h.ownerOf(c),
      inboundScope: target,
      limit: q.limit,
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      ...(q.q !== undefined ? { q: q.q } : {}),
    });
    for (const m of page.items) h.hideArchive(c, m);
    return c.json(page satisfies common.Paginated<mail.MailSentListItem>);
  });

  ext.get("/managed/:userId/sent/:id", async (c) => {
    const target = await assertManaged(c, h);
    const db = dbOf(c);
    const id = c.req.param("id");
    const msg = await getSentDetail(db, id, target, h.ownerOf(c));
    if (!msg) throw notFound("sent message", id);
    h.hideArchive(c, msg);
    const attachments = await attachmentsFor(db, "sent", msg.id);
    if (attachments.length > 0) msg.attachments = attachments;
    await auditOpen(c, "mail_sent", msg.id, target);
    return c.json(msg satisfies mail.MailSentDetail);
  });

  const download = (kind: "inbound" | "sent") => async (c: C) => {
    const target = await assertManaged(c, h);
    const blobs = buildBlobs(c.env);
    if (!blobs) throw new DubError("MAIL_ATTACHMENTS_UNCONFIGURED", "attachment storage not configured", { status: 503 });
    const messageId = c.req.param("id") ?? "";
    const attId = c.req.param("attId") ?? "";
    const db = dbOf(c);
    const visible = kind === "inbound" ? await getInboundDetail(db, messageId, target, target) : await getSentDetail(db, messageId, target, h.ownerOf(c));
    if (!visible) throw notFound("attachment", attId);
    const row = await getAttachment(db, kind, messageId, attId);
    if (!row) throw notFound("attachment", attId);
    if (row.status && row.status !== "stored") {
      throw new DubError("MAIL_ATTACHMENT_NOT_STORED", `attachment not stored (${row.status}): ${attId}`, { status: 409 });
    }
    const obj = await blobs.get(row.r2_key);
    if (!obj) throw notFound("attachment body", attId);
    await auditOpen(c, "mail_attachment", attId, target);
    return new Response(obj.body, {
      status: 200,
      headers: {
        "content-type": row.mime_type || obj.contentType,
        "content-length": String(obj.size),
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      },
    });
  };
  ext.get("/managed/:userId/messages/:id/attachments/:attId", download("inbound"));
  ext.get("/managed/:userId/sent/:id/attachments/:attId", download("sent"));
}
