// Hono app. Two disjoint surfaces on one Worker:
//   - internal (bare paths, reached via Service Binding): POST /send (idempotent),
//     /internal/*, /health/quota. Gated by x-dub-internal.
//   - external (mounted under /mail): /mail/outbox, /mail/messages, /mail/threads,
//     /mail/mailboxes. The gateway strips only API_PREFIX and preserves the segment,
//     forwarding /api/v1/mail/* -> the binding as /mail/*, so external routes must live
//     under /mail (mirrors identity-roster's /identity). Gated by trusted-header authn +
//     identity /authz/check (theme6).
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { DubError, errors, dubErrorHandler } from "@dub/errors";
import { dubContext } from "@dub/http";
import type { RequestContext } from "@dub/http";
import { createAuthClient } from "@dub/auth-client";
import { HEADERS } from "@dub/observability";
import { common, type identity, type mail } from "@dub/types";
import type { AppBindings } from "./env";
import { DEFAULT_OUTBOUND_PROVIDER, SERVICE_NAME } from "./config";
import { effectiveTuning, providerReadiness } from "./config-check";
import { emailRoutingReadiness } from "./email-routing";
import { registerEmailRoutingAdmin } from "./email-routing-routes";
import { buildDb, buildSendDeps } from "./deps";
import { resolveUserFromAddress } from "./from";
import { sendMail } from "./send";
import { deriveRateLimitStatus, parseCooldownSec } from "./rate-limit";
import { getInboundDetail, getSentDetail, latestFailedSend, listInbound, listSent, listMailboxes, listThread, markInboundRead, upsertMailbox } from "./repo";
import { parseListMessagesQuery, parseSendMailRequest } from "./validation";

export function createApp() {
  const app = new Hono<AppBindings>();

  app.onError(dubErrorHandler({ service: SERVICE_NAME }));
  app.use("*", dubContext({ allowGenerate: true }));

  const ctxOf = (c: Context<AppBindings>): RequestContext => c.get("dubCtx");
  const dbOf = (c: Context<AppBindings>) => buildDb(c.env, ctxOf(c).requestId);

  // ---- health
  app.get("/internal/health", (c) => c.json({ status: "ok", service: SERVICE_NAME }));

  // ---- readiness: internal-only. Reports whether the configured provider is actually
  // wired (credentials present) + non-secret tuning, so a deploy smoke-test can gate on
  // it. NEVER echoes a secret value. 200 when ready, 503 when not (issues listed).
  app.get("/internal/health/ready", (c) => {
    if (!c.req.header(HEADERS.internal)) throw errors.forbidden("internal-only");
    const readiness = providerReadiness(c.env);
    return c.json(
      { service: SERVICE_NAME, ...readiness, tuning: effectiveTuning(c.env), emailRouting: emailRoutingReadiness(c.env) },
      readiness.ready ? 200 : 503,
    );
  });

  // ---- POST /send: internal-binding only (design §2/§6). x-dub-internal absent -> 403
  // (gateway also 404s via internalOnlyPaths). Idempotency-Key required (二重送信ゼロ).
  app.post("/send", async (c) => {
    if (!c.req.header(HEADERS.internal)) throw errors.forbidden("POST /send is internal-only");
    const ctx = ctxOf(c);

    // If a user is on the call, enforce mail:send (dangerous -> always fresh). A pure
    // system-origin internal call (no x-dub-user-id) is trusted by the binding gate.
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
    const requester = c.req.header(HEADERS.caller) ?? userId ?? "unknown";
    const deps = buildSendDeps(c.env, ctx);
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
  // session identity: requireAuth (trusted x-dub-user-id) + mail:send. Idempotency-Key
  // is optional here (UI submit) — a fresh one is minted when absent so a retried submit
  // is still safe. Shares the exact send core, so 二重送信ゼロ still holds per key.
  ext.use("/outbox", withAuth("mail:send"));
  ext.post("/outbox", async (c) => {
    const ctx = ctxOf(c);
    const idempotencyKey = c.req.header(HEADERS.idempotencyKey) ?? crypto.randomUUID();
    const req = parseSendMailRequest(await c.req.json().catch(() => null));
    const userId = c.req.header(HEADERS.userId) ?? null;
    const requester = userId ?? "unknown";
    // From = the logged-in user's own @developershub.jp address (roster lookup), with a
    // safe info@ fallback for non-roster / non-company callers. See from.ts.
    const fromAddress = await resolveUserFromAddress(c.env, ctx, userId);
    const deps = buildSendDeps(c.env, ctx, undefined, fromAddress);
    const { response, status } = await sendMail(deps, req, idempotencyKey, requester);
    return c.json(response satisfies mail.SendMailResponse, status === "duplicate" ? 200 : 202);
  });

  // ---- read routes: mail:read (organizer 以上). requireAuth (trusted header) first.
  ext.use("/messages", withAuth("mail:read"));
  ext.use("/messages/*", withAuth("mail:read"));
  ext.use("/threads/*", withAuth("mail:read"));
  ext.use("/sent", withAuth("mail:read"));
  ext.use("/sent/*", withAuth("mail:read"));

  ext.get("/messages", async (c) => {
    const q = parseListMessagesQuery(c.req.query());
    const page = await listInbound(dbOf(c), q);
    return c.json(page satisfies common.Paginated<mail.MailMessageListItem>);
  });

  ext.get("/messages/:id", async (c) => {
    const msg = await getInboundDetail(dbOf(c), c.req.param("id"));
    if (!msg) throw new DubError("MAIL_MESSAGE_NOT_FOUND", `message not found: ${c.req.param("id")}`, { status: 404 });
    return c.json(msg satisfies mail.MailMessageDetail);
  });

  // Mark a message read (opened in the inbox). Idempotent: re-opening is a no-op.
  // mail:read is sufficient — reading a message you can see also flips its own read flag.
  // External (user-facing via gateway) so it lives on `ext` under /mail and inherits the
  // ext.use("/messages/*", withAuth("mail:read")) guard above.
  ext.post("/messages/:id/read", async (c) => {
    const { found } = await markInboundRead(dbOf(c), c.req.param("id"));
    if (!found) throw new DubError("MAIL_MESSAGE_NOT_FOUND", `message not found: ${c.req.param("id")}`, { status: 404 });
    return c.json({ read: true } satisfies mail.MailMessageState);
  });

  // ---- Sent folder (mail:read): the send-log projected as a Gmail-style Sent list +
  // detail. Only delivered (status='sent') rows are listed; pending/failed never show.
  ext.get("/sent", async (c) => {
    const q = parseListMessagesQuery(c.req.query());
    const page = await listSent(dbOf(c), { limit: q.limit, ...(q.cursor !== undefined ? { cursor: q.cursor } : {}) });
    return c.json(page satisfies common.Paginated<mail.MailSentListItem>);
  });

  ext.get("/sent/:id", async (c) => {
    const msg = await getSentDetail(dbOf(c), c.req.param("id"));
    if (!msg) throw new DubError("MAIL_MESSAGE_NOT_FOUND", `sent message not found: ${c.req.param("id")}`, { status: 404 });
    return c.json(msg satisfies mail.MailSentDetail);
  });

  ext.get("/threads/:id", async (c) => {
    const threadId = c.req.param("id");
    const messages = await listThread(dbOf(c), threadId);
    if (messages.length === 0) throw new DubError("MAIL_MESSAGE_NOT_FOUND", `thread not found: ${threadId}`, { status: 404 });
    return c.json({ id: threadId, messages } satisfies mail.MailThread);
  });

  // ---- mailbox admin: mail:admin.
  ext.use("/mailboxes", withAuth("mail:admin"));
  ext.use("/mailboxes/*", withAuth("mail:admin"));

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

  // ---- email-routing admin: mail:admin. Proxies the Cloudflare Email Routing API to
  // issue @developershub.jp addresses + manage forwarding rules from the admin console.
  registerEmailRoutingAdmin(ext, withAuth);

  app.route("/mail", ext);

  // ---- status: live send-health self-report (internal-only). Derives "directly rate-
  // limited" from the send-log so an operator dashboard (fe7 admin) can surface it. The
  // provider's own 429 already carries the exact Retry-After to the caller; this endpoint
  // reports whether we are still inside the cooldown window plus an ETA estimate.
  app.get("/internal/status", async (c) => {
    if (!c.req.header(HEADERS.internal)) throw errors.forbidden("internal-only");
    const cooldownSec = parseCooldownSec(c.env.MAIL_RATE_LIMIT_COOLDOWN_SEC);
    const latest = await latestFailedSend(dbOf(c));
    const rateLimit = deriveRateLimitStatus(latest, Date.now(), cooldownSec);
    return c.json({
      service: SERVICE_NAME,
      provider: (c.env.MAIL_OUTBOUND_PROVIDER ?? DEFAULT_OUTBOUND_PROVIDER).toLowerCase(),
      rateLimit,
    });
  });

  // ---- ops: quota/health self-report (internal-only, minimal in the CF-routing model).
  app.get("/health/quota", (c) => {
    if (!c.req.header(HEADERS.internal)) throw errors.forbidden("internal-only");
    return c.json({ service: SERVICE_NAME, provider: c.env.MAIL_OUTBOUND_PROVIDER ?? DEFAULT_OUTBOUND_PROVIDER, inboundTransport: "cf-email-routing" });
  });

  return app;
}

/** requireAuth (trusted header) + requirePermission chained on one per-request client. */
function withAuth(permission: identity.PermissionKey): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const client = createAuthClient({ identityBinding: c.env.SVC_IDENTITY, serviceName: SERVICE_NAME });
    c.set("authClient", client);
    await client.requireAuth()(c, async () => {
      await client.requirePermission(permission)(c, next);
    });
  };
}
