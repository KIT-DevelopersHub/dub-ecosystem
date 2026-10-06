// Hono app. Two disjoint surfaces on one Worker:
//   - internal (bare paths, reached via Service Binding): POST /send (idempotent),
//     /internal/*, /health/quota.
//   - external (mounted under /mail): /mail/outbox, /mail/messages, /mail/threads,
//     /mail/mailboxes, /mail/admin/*. The gateway strips only API_PREFIX and preserves the
//     segment, forwarding /api/v1/mail/* -> the binding as /mail/*, so external routes must
//     live under /mail (mirrors identity-roster's /identity).
//
// AUTHZ: no permission check in this file. `policyGate` is mounted on "*" below and derives
// both authn (the trusted x-dub-user-id header) and authz from POLICY_TABLE
// (src/policy-table.ts), which lists every route here — the internal-only ones included, so
// the old per-handler `if (!c.req.header(HEADERS.internal))` guards and the per-route
// `withAuth(key)` middleware are both gone. Do NOT add a permission check to a route or a
// handler; add the route to the table (test/policy-table.test.ts fails if you forget).
//
// What handlers DO still assert is per-resource / per-account SCOPE, which needs the
// request's data and therefore cannot live in a static table (see @dub/policy-gate's
// gate.ts header): `scopeOf` (own mail vs all accounts), `ownerOf` (personal rows) and the
// owner+status match on the scheduled-send mutations.
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { DubError, errors, dubErrorHandler } from "@dub/errors";
import { dubContext } from "@dub/http";
import type { RequestContext } from "@dub/http";
import { createAuthClient } from "@dub/auth-client";
import { policyGate, sharedAuthzGranter } from "@dub/policy-gate";
import { HEADERS } from "@dub/observability";
import { common, type mail } from "@dub/types";
import type { AppBindings } from "./env";
import { POLICY_TABLE } from "./policy-table";
import { DEFAULT_OUTBOUND_PROVIDER, SERVICE_NAME } from "./config";
import { effectiveTuning, providerReadiness } from "./config-check";
import { emailRoutingReadiness } from "./email-routing";
import { registerEmailRoutingAdmin } from "./email-routing-routes";
import { buildBlobs, buildDb, buildSendDeps } from "./deps";
import { attachmentsFor } from "./attachments";
import { resolveReplyFromAddress, resolveUserFromAddress } from "./from";
import { sendMail } from "./send";
import { deriveRateLimitStatus, parseCooldownSec } from "./rate-limit";
import { getAttachment, getInboundDetail, getSentDetail, latestFailedSend, listInbound, listSent, listMailboxes, listThread, listUserFlags, markInboundRead, upsertMailbox, upsertUserFlags, cancelScheduled, getScheduledDetail, insertScheduled, listScheduled, newScheduledId, updateScheduled, findScheduledRow, type MailScope } from "./repo";
import { parseListMessagesQuery, parseScheduleMailPatch, parseScheduleMailRequest, parseSendMailRequest } from "./validation";

export function createApp() {
  const app = new Hono<AppBindings>();

  app.onError(dubErrorHandler({ service: SERVICE_NAME }));
  app.use("*", dubContext({ allowGenerate: true }));

  const ctxOf = (c: Context<AppBindings>): RequestContext => c.get("dubCtx");
  const dbOf = (c: Context<AppBindings>) => buildDb(c.env, ctxOf(c).requestId);

  // ---- THE authorization layer. Mounted on every route, so it runs before every handler
  // including the ones registered below it; a route absent from POLICY_TABLE is denied
  // (403), never served. It replaces BOTH the per-route `withAuth(key)` middleware (=
  // requireAuth + requirePermission) AND the hand-rolled `x-dub-internal` checks that used
  // to sit inside four handlers — the latter are now the INTERNAL rule form, so the
  // internal-only routes are visible in the table instead of hiding in handler bodies.
  // `dubContext` above is pure x-dub-* header parsing (it makes no authorization decision)
  // and stays first so the gate's identity /authz/check call carries this request's
  // correlation id.
  //
  // The granter needs the identity Service Binding, which only exists per request (c.env),
  // so the gate instance is built here rather than at module scope. `as MiddlewareHandler`
  // is a typing bridge only: policyGate is declared for an app whose Variables are exactly
  // PolicyGateVars, while this app's Vars EXTENDS PolicyGateVars and adds Bindings, and
  // Hono's Context<E> is not comparable across that difference.
  app.use("*", (c, next) => {
    const gate = policyGate({
      service: SERVICE_NAME,
      table: POLICY_TABLE,
      // sharedAuthzGranter, not createAuthzGranter: the decision cache ADR 0004 requires is
      // memoized per Env, so it survives across requests served by the same isolate instead
      // of being freshly empty on every one (identity-roster sits on the hot path). The two
      // dangerous keys in this table (mail:send, mail:admin) are never cached regardless.
      granted: sharedAuthzGranter(c.env, c.env.SVC_IDENTITY, {
        caller: SERVICE_NAME,
        requestId: ctxOf(c).requestId,
      }),
    }) as MiddlewareHandler;
    return gate(c, next);
  });

  // The signed-in user. policyGate publishes it on every key-gated route (it 401s when the
  // trusted x-dub-user-id header is absent), so on every route that calls this it is set;
  // the throw is fail-closed insurance rather than silently scoping to "" if a rule is ever
  // changed to one that does not guarantee an actor.
  const ownerOf = (c: Context<AppBindings>): string => {
    const userId = c.get("userId");
    if (!userId) throw errors.forbidden("account scope requires an authenticated user");
    return userId;
  };
  // Read scope for the account-isolated read routes — a layer-2 (per-account) assertion,
  // which is why it stays here and not in the table: a caller holding `mail:read_all`
  // (oversight: admin / info@ / admin@) reads EVERY account's mail, so the owner filter is
  // dropped ({ readAll: true }); everyone else stays scoped to their own userId (#169,
  // fail-closed). The table has already established that the caller holds メール閲覧 +
  // mail:read before any of this runs. `mail:read_all` is `dangerous` in
  // PERMISSION_CATALOG, so @dub/auth-client re-asks identity every time (never cached).
  const scopeOf = async (c: Context<AppBindings>): Promise<MailScope> => {
    const userId = ownerOf(c);
    const client = createAuthClient({ identityBinding: c.env.SVC_IDENTITY, serviceName: SERVICE_NAME });
    const readAll = await client.hasPermission(
      userId,
      common.DUB_DEFAULT_ORG_ID,
      { permission: "mail:read_all" },
      { requestId: ctxOf(c).requestId },
    );
    return readAll ? { readAll: true } : userId;
  };

  // ---- health (PUBLIC in the table — the one route here that is, see policy-table.ts)
  app.get("/internal/health", (c) => c.json({ status: "ok", service: SERVICE_NAME }));

  // ---- readiness: INTERNAL in the table. Reports whether the configured provider is
  // actually wired (credentials present) + non-secret tuning, so a deploy smoke-test can
  // gate on it. NEVER echoes a secret value. 200 when ready, 503 when not (issues listed).
  app.get("/internal/health/ready", (c) => {
    const readiness = providerReadiness(c.env);
    return c.json(
      { service: SERVICE_NAME, ...readiness, tuning: effectiveTuning(c.env), emailRouting: emailRoutingReadiness(c.env) },
      readiness.ready ? 200 : 503,
    );
  });

  // ---- POST /send: internal-binding only (design §2/§6). INTERNAL in the table, which is
  // what 403s a caller without x-dub-internal (the gateway also 404s it via
  // internalOnlyPaths). Idempotency-Key required (二重送信ゼロ).
  app.post("/send", async (c) => {
    const ctx = ctxOf(c);

    // The CONDITIONAL half of the old guard, kept deliberately: if a user is on the call,
    // that user must hold mail:send (dangerous -> always fresh). It stays here rather than
    // moving into the table because it is a function of the REQUEST — most calls to this
    // route are system-origin and propagate no x-dub-user-id (a cron drain, a notification
    // fan-out), so `internalWithKeys(["mail:send"])` would 401 exactly the callers the route
    // exists for, while plain INTERNAL alone would let one compromised s2s caller send as
    // any user. See policy-table.ts's note on this route.
    const userId = c.req.header(HEADERS.userId);
    if (userId) {
      const authClient = createAuthClient({ identityBinding: c.env.SVC_IDENTITY, serviceName: SERVICE_NAME });
      const allowed = await authClient.hasPermission(
        userId,
        common.DUB_DEFAULT_ORG_ID,
        { permission: "mail:send" },
        { fresh: true, requestId: ctx.requestId },
      );
      if (!allowed) throw errors.forbidden("permission denied: mail:send");
    }

    const idempotencyKey = c.req.header(HEADERS.idempotencyKey);
    if (!idempotencyKey) throw new DubError("MAIL_INVALID_REQUEST", "Idempotency-Key header required", { status: 400 });

    const req = parseSendMailRequest(await c.req.json().catch(() => null));
    assertAttachmentsSupported(c, req);
    const requester = c.req.header(HEADERS.caller) ?? userId ?? "unknown";
    // Owner = the user on the call (Sent-folder scope); null for a pure system send.
    const deps = buildSendDeps(c.env, ctx, undefined, undefined, userId ?? null);
    const { response, status } = await sendMail(deps, req, idempotencyKey, requester);
    return c.json(response satisfies mail.SendMailResponse, status === "duplicate" ? 200 : 202);
  });

  // ===================== external surface (/mail/*) =====================
  // Mounted under /mail so gateway-forwarded /api/v1/mail/* (segment preserved) matches.
  // Internal callers (Service Bindings) address /send and /internal/* directly — those
  // stay at bare paths on the root app below and are unaffected.
  const ext = new Hono<AppBindings>();

  // ---- POST /outbox: USER-FACING compose+send (design 統合波). Unlike /send (internal
  // binding, system-origin), this is reachable through api-gateway with the caller's
  // session identity: メール編集 + mail:send in the table. Idempotency-Key is optional here
  // (UI submit) — a fresh one is minted when absent so a retried submit is still safe.
  // Shares the exact send core, so 二重送信ゼロ still holds per key.
  ext.post("/outbox", async (c) => {
    const ctx = ctxOf(c);
    const idempotencyKey = c.req.header(HEADERS.idempotencyKey) ?? crypto.randomUUID();
    const req = parseSendMailRequest(await c.req.json().catch(() => null));
    assertAttachmentsSupported(c, req);
    const userId = c.req.header(HEADERS.userId) ?? null;
    const requester = userId ?? "unknown";
    // From resolution:
    //  - a REPLY (inReplyTo present) goes out as the shared mailbox the parent was
    //    addressed to (e.g. info@), so the external correspondent sees a consistent
    //    identity AND their reply returns to that Worker-routed address (loop closes).
    //  - a fresh compose uses the logged-in user's own @developershub.jp address, with a
    //    safe info@ fallback for non-roster / non-company callers. See from.ts.
    const fromAddress = req.inReplyTo
      ? await resolveReplyFromAddress(c.env, ctx, dbOf(c), req.inReplyTo, userId)
      : await resolveUserFromAddress(c.env, ctx, userId);
    // Owner = the signed-in user so this send shows only in THEIR Sent folder (#169).
    const deps = buildSendDeps(c.env, ctx, undefined, fromAddress, userId);
    const { response, status } = await sendMail(deps, req, idempotencyKey, requester);
    return c.json(response satisfies mail.SendMailResponse, status === "duplicate" ? 200 : 202);
  });

  // ---- read routes: メール閲覧 + mail:read in the table (organizer 以上). Each handler's
  // only remaining job on the authorization side is `scopeOf` — WHOSE mail this caller may
  // see — which the table cannot answer.
  ext.get("/messages", async (c) => {
    const q = parseListMessagesQuery(c.req.query());
    const page = await listInbound(dbOf(c), { ...q, ownerUserId: await scopeOf(c) });
    return c.json(page satisfies common.Paginated<mail.MailMessageListItem>);
  });

  ext.get("/messages/:id", async (c) => {
    const db = dbOf(c);
    const msg = await getInboundDetail(db, c.req.param("id"), await scopeOf(c));
    if (!msg) throw new DubError("MAIL_MESSAGE_NOT_FOUND", `message not found: ${c.req.param("id")}`, { status: 404 });
    const attachments = await attachmentsFor(db, "inbound", msg.id);
    if (attachments.length > 0) msg.attachments = attachments;
    return c.json(msg satisfies mail.MailMessageDetail);
  });

  // Mark a message read (opened in the inbox). Idempotent: re-opening is a no-op.
  // メール閲覧 + mail:read is sufficient — reading a message you can see also flips its own
  // read flag, and `scopeOf` keeps it to a message this account may see.
  ext.post("/messages/:id/read", async (c) => {
    const { found } = await markInboundRead(dbOf(c), c.req.param("id"), await scopeOf(c));
    if (!found) throw new DubError("MAIL_MESSAGE_NOT_FOUND", `message not found: ${c.req.param("id")}`, { status: 404 });
    return c.json({ read: true } satisfies mail.MailMessageState);
  });

  // ---- Sent folder (mail:read): the send-log projected as a Gmail-style Sent list +
  // detail. Only delivered (status='sent') rows are listed; pending/failed never show.
  ext.get("/sent", async (c) => {
    const q = parseListMessagesQuery(c.req.query());
    const page = await listSent(dbOf(c), { ownerUserId: await scopeOf(c), limit: q.limit, ...(q.cursor !== undefined ? { cursor: q.cursor } : {}) });
    return c.json(page satisfies common.Paginated<mail.MailSentListItem>);
  });

  ext.get("/sent/:id", async (c) => {
    const db = dbOf(c);
    const msg = await getSentDetail(db, c.req.param("id"), await scopeOf(c));
    if (!msg) throw new DubError("MAIL_MESSAGE_NOT_FOUND", `sent message not found: ${c.req.param("id")}`, { status: 404 });
    const attachments = await attachmentsFor(db, "sent", msg.id);
    if (attachments.length > 0) msg.attachments = attachments;
    return c.json(msg satisfies mail.MailSentDetail);
  });

  // ---- Scheduled send (予約送信 / 予約投稿). ADDITIVE resource: create/list/edit/cancel a
  // compose parked for a future time. Delivery is done by the cron drain (scheduled-send.ts)
  // via the SAME send core, so 二重送信ゼロ / Sent folder / archive-CC all hold. Create/edit/
  // cancel need メール編集 + mail:send (they queue/alter an outbound); list/read need
  // メール閲覧 + mail:read. On top of that the mutations assert owner + status here.
  ext.post("/scheduled", async (c) => {
    const ctx = ctxOf(c);
    const userId = ownerOf(c);
    const req = parseScheduleMailRequest(await c.req.json().catch(() => null));
    // Resolve the envelope From now (same rules as /outbox) so the Scheduled list shows the
    // real From and the drain need not resolve later.
    const fromAddress = req.inReplyTo
      ? await resolveReplyFromAddress(c.env, ctx, dbOf(c), req.inReplyTo, userId)
      : await resolveUserFromAddress(c.env, ctx, userId);
    const id = newScheduledId();
    await insertScheduled(dbOf(c), {
      id,
      ownerUserId: userId,
      toJson: JSON.stringify(req.to),
      ccJson: JSON.stringify(req.cc ?? []),
      subject: req.subject,
      textBody: req.textBody,
      htmlBody: req.htmlBody ?? null,
      inReplyTo: req.inReplyTo ?? null,
      fromAddress,
      scheduledAt: req.scheduledAt,
    });
    return c.json({ id, scheduledAt: req.scheduledAt, status: "scheduled" } satisfies mail.ScheduleMailResponse, 202);
  });

  ext.get("/scheduled", async (c) => {
    const q = parseListMessagesQuery(c.req.query());
    const page = await listScheduled(dbOf(c), { ownerUserId: await scopeOf(c), limit: q.limit, ...(q.cursor !== undefined ? { cursor: q.cursor } : {}) });
    return c.json(page satisfies common.Paginated<mail.ScheduledSendListItem>);
  });

  ext.get("/scheduled/:id", async (c) => {
    const detail = await getScheduledDetail(dbOf(c), c.req.param("id"), await scopeOf(c));
    if (!detail) throw new DubError("MAIL_MESSAGE_NOT_FOUND", `scheduled send not found: ${c.req.param("id")}`, { status: 404 });
    return c.json(detail satisfies mail.ScheduledSendDetail);
  });

  // Edit / reschedule — only while still 'scheduled'. A row already sent/canceled 404s
  // (fail-closed) rather than silently no-op'ing.
  ext.patch("/scheduled/:id", async (c) => {
    const id = c.req.param("id");
    const owner = ownerOf(c);
    const patch = parseScheduleMailPatch(await c.req.json().catch(() => null));
    const changed = await updateScheduled(dbOf(c), id, owner, {
      ...(patch.to !== undefined ? { toJson: JSON.stringify(patch.to) } : {}),
      ...(patch.cc !== undefined ? { ccJson: JSON.stringify(patch.cc) } : {}),
      ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
      ...(patch.textBody !== undefined ? { textBody: patch.textBody } : {}),
      ...(patch.htmlBody !== undefined ? { htmlBody: patch.htmlBody } : {}),
      ...(patch.scheduledAt !== undefined ? { scheduledAt: patch.scheduledAt } : {}),
    });
    if (changed === 0) {
      // Distinguish "not yours / gone" from "no longer editable" for a clearer message.
      const existing = await findScheduledRow(dbOf(c), id, owner);
      if (!existing) throw new DubError("MAIL_MESSAGE_NOT_FOUND", `scheduled send not found: ${id}`, { status: 404 });
      throw new DubError("MAIL_INVALID_REQUEST", `scheduled send is no longer editable (status=${existing.status})`, { status: 409 });
    }
    const detail = await getScheduledDetail(dbOf(c), id, owner);
    if (!detail) throw new DubError("MAIL_MESSAGE_NOT_FOUND", `scheduled send not found: ${id}`, { status: 404 });
    return c.json(detail satisfies mail.ScheduledSendDetail);
  });

  // Cancel (取消) — flips status to 'canceled' while still 'scheduled'.
  ext.delete("/scheduled/:id", async (c) => {
    const id = c.req.param("id");
    const owner = ownerOf(c);
    const changed = await cancelScheduled(dbOf(c), id, owner);
    if (changed === 0) {
      const existing = await findScheduledRow(dbOf(c), id, owner);
      if (!existing) throw new DubError("MAIL_MESSAGE_NOT_FOUND", `scheduled send not found: ${id}`, { status: 404 });
      throw new DubError("MAIL_INVALID_REQUEST", `scheduled send is no longer cancelable (status=${existing.status})`, { status: 409 });
    }
    return c.json({ id, status: "canceled" });
  });

  ext.get("/threads/:id", async (c) => {
    const db = dbOf(c);
    const threadId = c.req.param("id");
    const messages = await listThread(db, threadId, await scopeOf(c));
    if (messages.length === 0) throw new DubError("MAIL_MESSAGE_NOT_FOUND", `thread not found: ${threadId}`, { status: 404 });
    for (const m of messages) {
      const attachments = await attachmentsFor(db, "inbound", m.id);
      if (attachments.length > 0) m.attachments = attachments;
    }
    return c.json({ id: threadId, messages } satisfies mail.MailThread);
  });

  // ---- attachment download (mail:read). Streams the R2 body with a download disposition.
  // Scoped by (message kind, message id, attachment id) so a mismatched id 404s. 503 when
  // the R2 bucket is not bound (feature off — fails loud, never silently serves nothing).
  const downloadAttachment = (kind: "inbound" | "sent") => async (c: Context<AppBindings>) => {
    const blobs = buildBlobs(c.env);
    if (!blobs) throw new DubError("MAIL_ATTACHMENTS_UNCONFIGURED", "attachment storage not configured", { status: 503 });
    const messageId = c.req.param("id") ?? "";
    const attId = c.req.param("attId") ?? "";
    const row = await getAttachment(dbOf(c), kind, messageId, attId);
    if (!row) throw new DubError("MAIL_MESSAGE_NOT_FOUND", `attachment not found: ${attId}`, { status: 404 });
    // A 'dropped_*' stub (改善#2: too large / truncated) has no R2 body — never fetch it.
    // 409 (not 404) so the UI can distinguish "unstorable" from "unknown id".
    if (row.status && row.status !== "stored") {
      throw new DubError("MAIL_ATTACHMENT_NOT_STORED", `attachment not stored (${row.status}): ${attId}`, { status: 409 });
    }
    const obj = await blobs.get(row.r2_key);
    if (!obj) throw new DubError("MAIL_MESSAGE_NOT_FOUND", "attachment body missing", { status: 404 });
    return new Response(obj.body, {
      status: 200,
      headers: {
        "content-type": row.mime_type || obj.contentType,
        "content-length": String(obj.size),
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      },
    });
  };
  ext.get("/messages/:id/attachments/:attId", downloadAttachment("inbound"));
  ext.get("/sent/:id/attachments/:attId", downloadAttachment("sent"));

  // ---- per-user thread flags (改善#8): star/archive/trash persisted server-side so they
  // survive a reload. PERSONAL to the signed-in user (never read_all): an admin's stars are
  // their own — `ownerOf`, not `scopeOf`, is the scope here and that is deliberate.
  // メール閲覧 + mail:read is sufficient (organizing mail you can see). GET returns every
  // stored flag row for the user; POST upserts one thread's flags (PATCH: only sent flags
  // change). A missing thread row means all-false (default), so the client seeds from GET.
  ext.get("/flags", async (c) => {
    const items = await listUserFlags(dbOf(c), ownerOf(c));
    return c.json({ items } satisfies { items: mail.MailThreadFlags[] });
  });

  ext.post("/flags/:threadId", async (c) => {
    const threadId = c.req.param("threadId");
    const patch = parseFlagsPatch(await c.req.json().catch(() => null));
    const flags = await upsertUserFlags(dbOf(c), ownerOf(c), threadId, patch);
    return c.json(flags satisfies mail.MailThreadFlags);
  });

  // ---- mailbox admin: the bare `mail:admin` key in the table (org infrastructure, not the
  // メール app's own surface — see policy-table.ts for why no app tier is paired here).
  ext.get("/mailboxes", async (c) => {
    const items = await listMailboxes(dbOf(c));
    return c.json({ items } satisfies { items: mail.Mailbox[] });
  });

  ext.post("/mailboxes/:id", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => null)) as { address?: unknown } | null;
    if (!body || typeof body.address !== "string") {
      throw new DubError("MAIL_INVALID_REQUEST", "address required", { status: 400 });
    }
    await upsertMailbox(dbOf(c), id, body.address);
    return c.json({ id, address: body.address }, 200);
  });

  // ---- email-routing admin: `mail:admin` in the table. Proxies the Cloudflare Email
  // Routing API to issue @developershub.jp addresses + manage forwarding rules from the
  // admin console. Every one of its 12 routes is listed individually in POLICY_TABLE, so a
  // route added in that file without a table line is denied and turns coverage red.
  registerEmailRoutingAdmin(ext);

  app.route("/mail", ext);

  // ---- status: live send-health self-report (INTERNAL in the table). Derives "directly
  // rate-limited" from the send-log so an operator dashboard (fe7 admin) can surface it. The
  // provider's own 429 already carries the exact Retry-After to the caller; this endpoint
  // reports whether we are still inside the cooldown window plus an ETA estimate.
  app.get("/internal/status", async (c) => {
    const cooldownSec = parseCooldownSec(c.env.MAIL_RATE_LIMIT_COOLDOWN_SEC);
    const latest = await latestFailedSend(dbOf(c));
    const rateLimit = deriveRateLimitStatus(latest, Date.now(), cooldownSec);
    return c.json({
      service: SERVICE_NAME,
      provider: (c.env.MAIL_OUTBOUND_PROVIDER ?? DEFAULT_OUTBOUND_PROVIDER).toLowerCase(),
      rateLimit,
    });
  });

  // ---- ops: quota/health self-report (INTERNAL in the table, minimal in the CF-routing
  // model).
  app.get("/health/quota", (c) => {
    return c.json({ service: SERVICE_NAME, provider: c.env.MAIL_OUTBOUND_PROVIDER ?? DEFAULT_OUTBOUND_PROVIDER, inboundTransport: "cf-email-routing" });
  });

  return app;
}

/** Reject a send carrying attachments when the R2 bucket is not bound (feature off) —
 *  fail loud with a 503 rather than silently dropping the files after "sent". */
function assertAttachmentsSupported(c: Context<AppBindings>, req: mail.SendMailRequest): void {
  if (req.attachments && req.attachments.length > 0 && !c.env.R2_MAIL) {
    throw new DubError("MAIL_ATTACHMENTS_UNCONFIGURED", "attachment storage not configured", { status: 503 });
  }
}

/** Validate a thread-flags PATCH body: an object with any of starred/archived/trashed/purged
 *  as booleans (purged = 完全に削除, per-user permanent hide; never a physical delete).
 *  Rejects a non-object or a non-boolean flag (400). An empty {} is allowed (a no-op upsert
 *  that just returns the current state). */
function parseFlagsPatch(body: unknown): mail.MailThreadFlagsPatch {
  if (body === null || typeof body !== "object") {
    throw new DubError("MAIL_INVALID_REQUEST", "flags patch must be an object", { status: 400 });
  }
  const src = body as Record<string, unknown>;
  const out: mail.MailThreadFlagsPatch = {};
  for (const key of ["starred", "archived", "trashed", "purged"] as const) {
    if (src[key] !== undefined) {
      if (typeof src[key] !== "boolean") {
        throw new DubError("MAIL_INVALID_REQUEST", `flag "${key}" must be a boolean`, { status: 400 });
      }
      out[key] = src[key] as boolean;
    }
  }
  return out;
}
