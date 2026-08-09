// Hono app: POST /send (internal-only, idempotent), read routes (/messages, /threads),
// mailbox admin, health. Auth: trusted-header authn + identity /authz/check (theme6).
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { DubError, errors, dubErrorHandler } from "@dub/errors";
import { dubContext } from "@dub/http";
import type { RequestContext } from "@dub/http";
import { createAuthClient } from "@dub/auth-client";
import { HEADERS } from "@dub/observability";
import { common, type identity, type mail } from "@dub/types";
import type { AppBindings } from "./env";
import { SERVICE_NAME } from "./config";
import { buildDb, buildSendDeps } from "./deps";
import { sendMail } from "./send";
import { getInboundById, listInbound, listMailboxes, upsertMailbox } from "./repo";
import { parseListMessagesQuery, parseSendMailRequest } from "./validation";

export function createApp() {
  const app = new Hono<AppBindings>();

  app.onError(dubErrorHandler({ service: SERVICE_NAME }));
  app.use("*", dubContext({ allowGenerate: true }));

  const ctxOf = (c: Context<AppBindings>): RequestContext => c.get("dubCtx");
  const dbOf = (c: Context<AppBindings>) => buildDb(c.env, ctxOf(c).requestId);

  // ---- health
  app.get("/internal/health", (c) => c.json({ status: "ok", service: SERVICE_NAME }));

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

  // ---- read routes: mail:read (organizer 以上). requireAuth (trusted header) first.
  app.use("/messages", withAuth("mail:read"));
  app.use("/messages/*", withAuth("mail:read"));
  app.use("/threads/*", withAuth("mail:read"));

  app.get("/messages", async (c) => {
    const q = parseListMessagesQuery(c.req.query());
    const page = await listInbound(dbOf(c), q);
    return c.json(page satisfies common.Paginated<mail.MailMessage>);
  });

  app.get("/messages/:id", async (c) => {
    const msg = await getInboundById(dbOf(c), c.req.param("id"));
    if (!msg) throw new DubError("MAIL_MESSAGE_NOT_FOUND", `message not found: ${c.req.param("id")}`, { status: 404 });
    return c.json(msg satisfies mail.MailMessage);
  });

  app.get("/threads/:id", async (c) => {
    const threadId = c.req.param("id");
    const page = await listInbound(dbOf(c), { threadId, limit: 200 });
    if (page.items.length === 0) throw new DubError("MAIL_MESSAGE_NOT_FOUND", `thread not found: ${threadId}`, { status: 404 });
    return c.json({ id: threadId, messages: page.items });
  });

  // ---- mailbox admin: mail:admin.
  app.use("/mailboxes", withAuth("mail:admin"));
  app.use("/mailboxes/*", withAuth("mail:admin"));

  app.get("/mailboxes", async (c) => {
    const items = await listMailboxes(dbOf(c));
    return c.json({ items } satisfies { items: mail.Mailbox[] });
  });

  app.post("/mailboxes/:id", async (c) => {
    const id = c.req.param("id");
    const body = (await c.req.json().catch(() => null)) as { address?: unknown } | null;
    if (!body || typeof body.address !== "string") {
      throw new DubError("MAIL_INVALID_REQUEST", "address required", { status: 400 });
    }
    await upsertMailbox(dbOf(c), id, body.address);
    return c.json({ id, address: body.address }, 200);
  });

  // ---- ops: quota/health self-report (internal-only, minimal in the CF-routing model).
  app.get("/health/quota", (c) => {
    if (!c.req.header(HEADERS.internal)) throw errors.forbidden("internal-only");
    return c.json({ service: SERVICE_NAME, provider: c.env.MAIL_OUTBOUND_PROVIDER ?? "ses", inboundTransport: "cf-email-routing" });
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
