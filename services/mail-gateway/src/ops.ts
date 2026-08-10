// Gmail-parity操作系 routes. Registered onto the existing `ext` (/mail/*) and root `app`
// sub-apps by createApp(). Split out of app.ts so the base send/inbound surface stays a
// tiny diff and the parallel deploy波 rebases cleanly.
//
// Surfaces added (all under /mail unless noted):
//   flags   POST /messages/:id/{star,unstar,archive,unarchive,trash,untrash,unread}
//           DELETE /messages/:id                                 (permanent, mail:admin)
//   thread  POST /threads/:id/{star,unstar,archive,unarchive,trash,untrash}
//   labels  GET /labels · POST /labels · PATCH/DELETE /labels/:id
//           POST /messages/:id/labels · DELETE /messages/:id/labels/:labelId
//   compose POST /messages/:id/{reply,replyAll,forward}         (mail:send)
//   drafts  GET/POST /drafts · GET/PUT/DELETE /drafts/:id        (mail:send)
//   sent    GET /sent                                            (mail:read)
//   freeq   POST /internal/outbox/drain                          (internal-only)
import { Hono, type Context } from "hono";
import { DubError, errors } from "@dub/errors";
import { createAuthClient } from "@dub/auth-client";
import { nowIso } from "@dub/db";
import { HEADERS } from "@dub/observability";
import { common, type auditLog, type mail } from "@dub/types";
import type { AppBindings } from "./env";
import type { RequestContext } from "@dub/http";
import { SERVICE_NAME } from "./config";
import { buildDb, buildSendDeps } from "./deps";
import { getInboundDetail, listInbound } from "./repo";
import { sendMail } from "./send";
import { drainOutbox } from "./outbox";
import type { MailMessageDetailX } from "./ops-dto";
import {
  applyLabel,
  createDraft,
  createLabel,
  deleteDraft,
  deleteInbound,
  deleteLabel,
  enqueueOutbox,
  getDraft,
  listDrafts,
  listLabels,
  listSent,
  markInboundUnread,
  removeLabel,
  setArchived,
  setStarred,
  setThreadFlag,
  setTrashed,
  updateDraft,
  updateLabel,
  type DraftInput,
} from "./ops-repo";
import {
  parseApplyLabelRequest,
  parseCreateLabelRequest,
  parseDraftRequest,
  parseForwardRequest,
  parseListMessagesQuery,
  parseReplyRequest,
  parseUpdateLabelRequest,
} from "./validation";
import type { MiddlewareHandler } from "hono";
import type { identity } from "@dub/types";

type C = Context<AppBindings>;

const ctxOf = (c: C): RequestContext => c.get("dubCtx");
const dbOf = (c: C) => buildDb(c.env, ctxOf(c).requestId);

/** Enqueue a mutation audit record to the D1 outbox (freeq) — async, off the request path. */
async function auditMutation(
  c: C,
  action: string,
  resourceType: string,
  resourceId: string,
  details: Record<string, unknown>,
): Promise<void> {
  const ctx = ctxOf(c);
  const input: auditLog.AuditRecordInput = {
    action,
    actorId: ctx.userId ?? null,
    orgId: common.DUB_DEFAULT_ORG_ID,
    result: "success",
    resourceType,
    resourceId,
    details,
    requestId: ctx.requestId,
    occurredAt: nowIso(),
  };
  // Best-effort: a full outbox / DB hiccup must not fail the completed mutation.
  try {
    await enqueueOutbox(dbOf(c), "audit", input);
  } catch {
    /* swallow — the state change already succeeded; audit is async/best-effort */
  }
}

/** Inline permission gate for routes that need a stronger permission than the group's
 *  middleware already applied (e.g. reply needs mail:send atop the /messages/* mail:read). */
async function requirePerm(c: C, permission: identity.PermissionKey): Promise<void> {
  const userId = c.req.header(HEADERS.userId);
  if (!userId) throw errors.forbidden(`permission denied: ${permission}`);
  const client = createAuthClient({ identityBinding: c.env.SVC_IDENTITY, serviceName: SERVICE_NAME });
  const allowed = await client.hasPermission(userId, common.DUB_DEFAULT_ORG_ID, { permission }, { fresh: true, requestId: ctxOf(c).requestId });
  if (!allowed) throw errors.forbidden(`permission denied: ${permission}`);
}

function ensurePrefix(prefix: "Re:" | "Fwd:", subject: string): string {
  const key = prefix.toLowerCase();
  return subject.trim().toLowerCase().startsWith(key) ? subject : `${prefix} ${subject}`;
}

function quote(orig: mail.MailMessageDetail): string {
  const who = orig.from.name ? `${orig.from.name} <${orig.from.email}>` : orig.from.email;
  const lines = (orig.textBody ?? "").split("\n").map((l) => `> ${l}`).join("\n");
  return `On ${orig.receivedAt}, ${who} wrote:\n${lines}`;
}

export function registerMailOps(app: Hono<AppBindings>, ext: Hono<AppBindings>, withAuth: (p: identity.PermissionKey) => MiddlewareHandler<AppBindings>): void {
  const notFound = (id: string): never => {
    throw new DubError("MAIL_MESSAGE_NOT_FOUND", `message not found: ${id}`, { status: 404 });
  };

  // ===================== message flags (inherit /messages/* mail:read) =====================
  const flag = (
    action: string,
    field: "starred" | "archived" | "trashed",
    on: boolean,
    fn: (db: ReturnType<typeof dbOf>, id: string) => Promise<{ found: boolean }>,
  ) => {
    return async (c: C) => {
      const id = c.req.param("id")!;
      const { found } = await fn(dbOf(c), id);
      if (!found) notFound(id);
      await auditMutation(c, action, "mail_message", id, { [field]: on });
      return c.json({ id, [field]: on });
    };
  };

  ext.post("/messages/:id/star", flag("mail.message.star", "starred", true, (db, id) => setStarred(db, id, true)));
  ext.post("/messages/:id/unstar", flag("mail.message.star", "starred", false, (db, id) => setStarred(db, id, false)));
  ext.post("/messages/:id/archive", flag("mail.message.archive", "archived", true, (db, id) => setArchived(db, id, true)));
  ext.post("/messages/:id/unarchive", flag("mail.message.archive", "archived", false, (db, id) => setArchived(db, id, false)));
  ext.post("/messages/:id/trash", flag("mail.message.trash", "trashed", true, (db, id) => setTrashed(db, id, true)));
  ext.post("/messages/:id/untrash", flag("mail.message.trash", "trashed", false, (db, id) => setTrashed(db, id, false)));

  // read/unread toggle: /read (mark read) exists in app.ts; /unread is its inverse.
  ext.post("/messages/:id/unread", async (c) => {
    const id = c.req.param("id");
    const { found } = await markInboundUnread(dbOf(c), id);
    if (!found) notFound(id);
    await auditMutation(c, "mail.message.unread", "mail_message", id, { read: false });
    return c.json({ id, read: false } satisfies mail.MailMessageState & { id: string });
  });

  // Permanent delete — destructive, so mail:admin (stronger than the group's mail:read).
  ext.delete("/messages/:id", async (c) => {
    await requirePerm(c, "mail:admin");
    const id = c.req.param("id");
    const { found } = await deleteInbound(dbOf(c), id);
    if (!found) notFound(id);
    await auditMutation(c, "mail.message.delete", "mail_message", id, {});
    return c.json({ id, deleted: true });
  });

  // ===================== label apply/remove on a message (mail:read) =====================
  ext.post("/messages/:id/labels", async (c) => {
    const id = c.req.param("id");
    const { labelId } = parseApplyLabelRequest(await c.req.json().catch(() => null));
    const { messageFound, labelFound } = await applyLabel(dbOf(c), id, labelId);
    if (!messageFound) notFound(id);
    if (!labelFound) throw new DubError("MAIL_LABEL_NOT_FOUND", `label not found: ${labelId}`, { status: 404 });
    await auditMutation(c, "mail.message.label", "mail_message", id, { labelId, applied: true });
    return c.json({ id, labelId, applied: true });
  });

  ext.delete("/messages/:id/labels/:labelId", async (c) => {
    const id = c.req.param("id");
    const labelId = c.req.param("labelId");
    const { found } = await removeLabel(dbOf(c), id, labelId);
    if (!found) notFound(id);
    await auditMutation(c, "mail.message.label", "mail_message", id, { labelId, applied: false });
    return c.json({ id, labelId, applied: false });
  });

  // ===================== thread-level flags (inherit /threads/* mail:read) =====================
  const threadFlag = (action: string, field: "starred" | "archived" | "trashed", column: "starred_at" | "archived_at" | "trashed_at", on: boolean) => {
    return async (c: C) => {
      const threadId = c.req.param("id")!;
      const { affected } = await setThreadFlag(dbOf(c), threadId, column, on);
      await auditMutation(c, action, "mail_thread", threadId, { [field]: on, affected });
      return c.json({ threadId, [field]: on, affected });
    };
  };
  ext.post("/threads/:id/star", threadFlag("mail.thread.star", "starred", "starred_at", true));
  ext.post("/threads/:id/unstar", threadFlag("mail.thread.star", "starred", "starred_at", false));
  ext.post("/threads/:id/archive", threadFlag("mail.thread.archive", "archived", "archived_at", true));
  ext.post("/threads/:id/unarchive", threadFlag("mail.thread.archive", "archived", "archived_at", false));
  ext.post("/threads/:id/trash", threadFlag("mail.thread.trash", "trashed", "trashed_at", true));
  ext.post("/threads/:id/untrash", threadFlag("mail.thread.trash", "trashed", "trashed_at", false));

  // ===================== reply / replyAll / forward (mail:send) =====================
  // These live under /messages/* so the group's mail:read middleware runs first; we then
  // require mail:send inline (you must be able to both read the thread and send).
  const loadOriginal = async (c: C): Promise<MailMessageDetailX> => {
    const id = c.req.param("id")!;
    const orig = await getInboundDetail(dbOf(c), id);
    if (!orig) notFound(id);
    return orig!;
  };
  const doSend = async (c: C, req: mail.SendMailRequest) => {
    const ctx = ctxOf(c);
    const idempotencyKey = c.req.header(HEADERS.idempotencyKey) ?? crypto.randomUUID();
    const requester = c.req.header(HEADERS.userId) ?? "unknown";
    const { response, status } = await sendMail(buildSendDeps(c.env, ctx), req, idempotencyKey, requester);
    return c.json(response satisfies mail.SendMailResponse, status === "duplicate" ? 200 : 202);
  };

  ext.post("/messages/:id/reply", async (c) => {
    await requirePerm(c, "mail:send");
    const orig = await loadOriginal(c);
    const body = parseReplyRequest(await c.req.json().catch(() => null));
    const req: mail.SendMailRequest = {
      to: [orig.from],
      subject: ensurePrefix("Re:", orig.subject),
      textBody: `${body.textBody}\n\n${quote(orig)}`,
      inReplyTo: orig.messageId,
    };
    if (body.htmlBody !== undefined) req.htmlBody = body.htmlBody;
    return doSend(c, req);
  });

  ext.post("/messages/:id/replyAll", async (c) => {
    await requirePerm(c, "mail:send");
    const orig = await loadOriginal(c);
    const body = parseReplyRequest(await c.req.json().catch(() => null));
    const self = (c.env.MAIL_FROM_ADDRESS ?? "").toLowerCase();
    const seen = new Set<string>();
    const recipients: mail.MailAddress[] = [];
    for (const a of [orig.from, ...orig.to]) {
      const key = a.email.toLowerCase();
      if (key === self || seen.has(key)) continue;
      seen.add(key);
      recipients.push(a);
    }
    const req: mail.SendMailRequest = {
      to: recipients.length > 0 ? recipients : [orig.from],
      subject: ensurePrefix("Re:", orig.subject),
      textBody: `${body.textBody}\n\n${quote(orig)}`,
      inReplyTo: orig.messageId,
    };
    if (body.htmlBody !== undefined) req.htmlBody = body.htmlBody;
    return doSend(c, req);
  });

  ext.post("/messages/:id/forward", async (c) => {
    await requirePerm(c, "mail:send");
    const orig = await loadOriginal(c);
    const body = parseForwardRequest(await c.req.json().catch(() => null));
    const fwdHeader = `---------- Forwarded message ----------\nFrom: ${orig.from.email}\nSubject: ${orig.subject}\n\n`;
    const note = body.textBody ? `${body.textBody}\n\n` : "";
    const req: mail.SendMailRequest = {
      to: body.to,
      subject: ensurePrefix("Fwd:", orig.subject),
      textBody: `${note}${fwdHeader}${orig.textBody ?? ""}`,
    };
    if (body.htmlBody !== undefined) req.htmlBody = body.htmlBody;
    return doSend(c, req);
  });

  // ===================== labels registry =====================
  ext.get("/labels", withAuth("mail:read"), async (c) => {
    return c.json({ items: await listLabels(dbOf(c)) });
  });
  ext.post("/labels", withAuth("mail:admin"), async (c) => {
    const { name, color } = parseCreateLabelRequest(await c.req.json().catch(() => null));
    const label = await createLabel(dbOf(c), name, color);
    await auditMutation(c, "mail.label.create", "mail_label", label.id, { name });
    return c.json(label, 201);
  });
  ext.patch("/labels/:id", withAuth("mail:admin"), async (c) => {
    const id = c.req.param("id");
    const patch = parseUpdateLabelRequest(await c.req.json().catch(() => null));
    const label = await updateLabel(dbOf(c), id, patch);
    if (!label) throw new DubError("MAIL_LABEL_NOT_FOUND", `label not found: ${id}`, { status: 404 });
    await auditMutation(c, "mail.label.update", "mail_label", id, { ...patch });
    return c.json(label);
  });
  ext.delete("/labels/:id", withAuth("mail:admin"), async (c) => {
    const id = c.req.param("id");
    const { found } = await deleteLabel(dbOf(c), id);
    if (!found) throw new DubError("MAIL_LABEL_NOT_FOUND", `label not found: ${id}`, { status: 404 });
    await auditMutation(c, "mail.label.delete", "mail_label", id, {});
    return c.json({ id, deleted: true });
  });

  // ===================== drafts (mail:send) =====================
  ext.use("/drafts", withAuth("mail:send"));
  ext.use("/drafts/*", withAuth("mail:send"));
  const toDraftInput = (b: ReturnType<typeof parseDraftRequest>): DraftInput => {
    const input: DraftInput = { to: b.to, subject: b.subject, textBody: b.textBody };
    if (b.cc !== undefined) input.cc = b.cc;
    if (b.htmlBody !== undefined) input.htmlBody = b.htmlBody;
    if (b.inReplyTo !== undefined) input.inReplyTo = b.inReplyTo;
    if (b.threadId !== undefined) input.threadId = b.threadId;
    return input;
  };
  ext.get("/drafts", async (c) => c.json({ items: await listDrafts(dbOf(c)) }));
  ext.post("/drafts", async (c) => {
    const input = toDraftInput(parseDraftRequest(await c.req.json().catch(() => null)));
    const draft = await createDraft(dbOf(c), input);
    return c.json(draft, 201);
  });
  ext.get("/drafts/:id", async (c) => {
    const draft = await getDraft(dbOf(c), c.req.param("id"));
    if (!draft) throw new DubError("MAIL_DRAFT_NOT_FOUND", `draft not found: ${c.req.param("id")}`, { status: 404 });
    return c.json(draft);
  });
  ext.put("/drafts/:id", async (c) => {
    const id = c.req.param("id");
    const input = toDraftInput(parseDraftRequest(await c.req.json().catch(() => null)));
    const draft = await updateDraft(dbOf(c), id, input);
    if (!draft) throw new DubError("MAIL_DRAFT_NOT_FOUND", `draft not found: ${id}`, { status: 404 });
    return c.json(draft);
  });
  ext.delete("/drafts/:id", async (c) => {
    const { found } = await deleteDraft(dbOf(c), c.req.param("id"));
    if (!found) throw new DubError("MAIL_DRAFT_NOT_FOUND", `draft not found: ${c.req.param("id")}`, { status: 404 });
    return c.json({ id: c.req.param("id"), deleted: true });
  });

  // ===================== sent folder (mail:read) =====================
  ext.get("/sent", withAuth("mail:read"), async (c) => {
    const q = parseListMessagesQuery(c.req.query());
    const page = await listSent(dbOf(c), { limit: q.limit, ...(q.cursor !== undefined ? { cursor: q.cursor } : {}) });
    return c.json(page);
  });

  // ===================== freeq drain (internal-only) =====================
  app.post("/internal/outbox/drain", async (c) => {
    if (!c.req.header(HEADERS.internal)) throw errors.forbidden("internal-only");
    const result = await drainOutbox(dbOf(c), { AUDIT_QUEUE: c.env.AUDIT_QUEUE });
    return c.json({ service: SERVICE_NAME, ...result });
  });
}
