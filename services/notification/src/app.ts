// Hono app: POST /notify (internal-only, 3-lane ingest lane C), self-scoped inbox
// (list / unread-count / read / read-all) and preferences (get / update), health.
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { DubError, errors, dubErrorHandler } from "@dub/errors";
import { dubContext } from "@dub/http";
import type { RequestContext } from "@dub/http";
import { createAuthClient, getUserId } from "@dub/auth-client";
import { HEADERS } from "@dub/observability";
import type { notification } from "@dub/types";
import type { AppBindings } from "./env";
import { SERVICE_NAME, CHANNELS } from "./config";
import { buildDb, buildIngestDeps } from "./deps";
import { ingest } from "./ingest";
import {
  listInbox,
  unreadCount,
  markRead,
  markAllRead,
  backfillBroadcastInbox,
  listPreferenceOverrides,
  upsertPreference,
  deletePreference,
  insertFeedback,
  listFeedback,
  markFeedbackRead,
} from "./repo";
import { mergedView, defaultEnabled } from "./preferences";
import {
  parseNotifyRequest,
  parseListInboxQuery,
  parseReadAll,
  parsePreferencesUpdate,
  parseCreateFeedback,
  parseListFeedbackQuery,
  parseReleaseRequest,
} from "./validation";
import { makeMailPort, type MailPort, type IdentityPort } from "./clients";
import { notifyAdminOfFeedback, notifyAdminsOfFeedbackInApp } from "./feedback";
import { publishRelease, seedInitialReleases } from "./release";
import { FEEDBACK_ADMIN_PERMISSION, RELEASE_ADMIN_PERMISSION } from "./config";
import type { IngestInput } from "./types";

interface GetPreferencesResponse {
  userId: string;
  entries: notification.PreferenceEntry[];
}
interface NotifyResponse {
  notificationId: string;
  deduplicated: boolean;
}

export interface CreateAppOptions {
  /** Override the mail port (tests). Defaults to a per-request SVC_MAIL_GATEWAY-backed
   *  port at runtime, or null when the binding is absent (feedback notify -> skipped). */
  mail?: MailPort;
  /** Override the identity port (tests) used to expand roles → user ids for the in-app
   *  feedback admin notification. Defaults to the SVC_IDENTITY-backed port. */
  identity?: IdentityPort;
}

export function createApp(options: CreateAppOptions = {}) {
  const app = new Hono<AppBindings>();

  app.onError(dubErrorHandler({ service: SERVICE_NAME }));
  app.use("*", dubContext({ allowGenerate: true }));

  const ctxOf = (c: Context<AppBindings>): RequestContext => c.get("dubCtx");
  const dbOf = (c: Context<AppBindings>) => buildDb(c.env, ctxOf(c).requestId);
  const mailOf = (c: Context<AppBindings>): MailPort | null =>
    options.mail ?? (c.env.SVC_MAIL_GATEWAY ? makeMailPort(c.env.SVC_MAIL_GATEWAY) : null);
  const ingestDepsOf = (c: Context<AppBindings>, ctx: RequestContext) =>
    buildIngestDeps(c.env, ctx, options.identity ? { identity: options.identity } : {});

  // ---- health
  app.get("/internal/health", (c) => c.json({ status: "ok", service: SERVICE_NAME }));

  // ---- POST /notify: internal binding only (design §2/§6). Receiving-side gate:
  // x-dub-internal absent -> 403 FORBIDDEN (gateway also 404s via internalOnlyPaths).
  app.post("/notify", async (c) => {
    if (!c.req.header(HEADERS.internal)) throw errors.forbidden("POST /notify is internal-only");
    const parsed = parseNotifyRequest(await c.req.json().catch(() => null));
    const ctx = ctxOf(c);
    const actorId = c.req.header(HEADERS.userId) ?? null;
    const input: IngestInput = {
      type: parsed.type,
      recipients: { userIds: parsed.recipientIds },
      title: parsed.title,
      body: parsed.body,
      priority: "normal",
      source: "api",
      actorId,
      requestId: ctx.requestId,
      resourceType: parsed.resourceType ?? null,
      resourceId: parsed.resourceId ?? null,
      ...(parsed.channels ? { channels: parsed.channels } : {}),
      ...(parsed.dedupKey ? { dedupKey: parsed.dedupKey } : {}),
    };
    const deps = buildIngestDeps(c.env, ctx);
    const result = await ingest(deps, input);
    const res: NotifyResponse = result;
    return c.json(res, 202);
  });

  // ---- POST /release: admin-published "🎉 new feature" release note, broadcast to
  // EVERY active user's inbox (in_app, forced on). External surface (gateway does NOT
  // 404 it); admin gate is enforced in-service via notif:admin. Idempotent per dedupKey.
  app.use("/release", authOnly);
  app.post("/release", requireReleaseAdmin, async (c) => {
    const parsed = parseReleaseRequest(await c.req.json().catch(() => null));
    const ctx = ctxOf(c);
    const actorId = c.req.header(HEADERS.userId) ?? null;
    const result = await publishRelease(ingestDepsOf(c, ctx), ctx, parsed, actorId);
    return c.json(result satisfies NotifyResponse, 202);
  });

  // ---- POST /internal/seed-releases: internal-only (x-dub-internal). (Re)publishes the
  // curated release back-catalog idempotently — the automation seam a deploy hook can
  // call so new releases surface without a manual admin publish.
  app.post("/internal/seed-releases", async (c) => {
    if (!c.req.header(HEADERS.internal)) throw errors.forbidden("seed-releases is internal-only");
    const ctx = ctxOf(c);
    const actorId = c.req.header(HEADERS.userId) ?? null;
    const result = await seedInitialReleases(ingestDepsOf(c, ctx), ctx, actorId);
    return c.json(result, 202);
  });

  // ---- self-scoped routes: requireAuth (trusted header -> x-dub-user-id = 本人).
  // No requirePermission: notif:inbox:self / notif:prefs:self are not in the frozen
  // PERMISSION_CATALOG; self-access is enforced by scoping every query to userId.
  app.use("/inbox/*", authOnly);
  app.use("/inbox", authOnly);
  app.use("/preferences", authOnly);

  app.get("/inbox", async (c) => {
    const userId = getUserId(c);
    const db = dbOf(c);
    // Backfill broadcast rows this user is missing (late-join safety) before listing, so
    // release notes always appear regardless of when the user was created (bugfix).
    await backfillBroadcastInbox(db, userId);
    const q = parseListInboxQuery(c.req.query());
    const page = await listInbox(db, userId, q);
    return c.json(page satisfies notification.ListInboxResponse);
  });

  app.get("/inbox/unread-count", async (c) => {
    const userId = getUserId(c);
    const db = dbOf(c);
    // Same backfill as GET /inbox so the header unread badge counts broadcasts a late-join
    // user never received a fan-out row for.
    await backfillBroadcastInbox(db, userId);
    const count = await unreadCount(db, userId);
    return c.json({ count } satisfies notification.UnreadCountResponse);
  });

  app.patch("/inbox/:id/read", async (c) => {
    const userId = getUserId(c);
    const ok = await markRead(dbOf(c), userId, c.req.param("id"));
    if (!ok) {
      throw new DubError("NOTIF_INBOX_ITEM_NOT_FOUND", `inbox item not found: ${c.req.param("id")}`, { status: 404 });
    }
    return c.json({ ok: true });
  });

  app.post("/inbox/read-all", async (c) => {
    const userId = getUserId(c);
    const { type } = parseReadAll(await c.req.json().catch(() => null));
    const updated = await markAllRead(dbOf(c), userId, type);
    return c.json({ updated });
  });

  app.get("/preferences", async (c) => {
    const userId = getUserId(c);
    const overrides = await listPreferenceOverrides(dbOf(c), userId);
    const res: GetPreferencesResponse = { userId, entries: mergedView(overrides) };
    return c.json(res);
  });

  app.patch("/preferences", async (c) => {
    const userId = getUserId(c);
    const entries = parsePreferencesUpdate(await c.req.json().catch(() => null));
    const db = dbOf(c);
    for (const entry of entries) {
      for (const channel of CHANNELS) {
        const enabled = entry.channels.includes(channel);
        // Drop the override row when it equals the system default (design §2).
        if (enabled === defaultEnabled(entry.type, channel, "normal")) {
          await deletePreference(db, userId, entry.type, channel);
        } else {
          await upsertPreference(db, userId, entry.type, channel, enabled);
        }
      }
    }
    const overrides = await listPreferenceOverrides(db, userId);
    const res: GetPreferencesResponse = { userId, entries: mergedView(overrides) };
    return c.json(res);
  });

  // ---- in-app feedback (widget). POST is any authenticated user; GET/PATCH are the
  // admin read surface (notif:admin). The gateway routes /api/v1/feedback -> here via
  // the "feedback" segment bound to SVC_NOTIFICATION.
  app.use("/feedback", authOnly); // requireAuth for POST + GET (permission on GET below)
  app.use("/feedback/*", authOnly);

  app.post("/feedback", async (c) => {
    const userId = getUserId(c);
    const parsed = parseCreateFeedback(await c.req.json().catch(() => null));
    const ctx = ctxOf(c);
    const item = await insertFeedback(dbOf(c), {
      userId,
      category: parsed.category ?? "other",
      message: parsed.message,
      pageUrl: parsed.page?.url ?? null,
      pageName: parsed.page?.name ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      requestId: ctx.requestId,
    });
    // Best-effort admin alert — never blocks the save / 201.
    await notifyAdminOfFeedback(mailOf(c), ctx, item);
    // In-app notification into every admin / maintainer inbox (synchronous D1 write via
    // the shared ingest path; also best-effort so the save / 201 is never affected).
    await notifyAdminsOfFeedbackInApp(ingestDepsOf(c, ctx), ctx, item);
    const res: notification.CreateFeedbackResponse = { id: item.id, accepted: true };
    return c.json(res, 201);
  });

  app.get("/feedback", requireFeedbackAdmin, async (c) => {
    const q = parseListFeedbackQuery(c.req.query());
    const page = await listFeedback(dbOf(c), q);
    return c.json(page satisfies notification.ListFeedbackResponse);
  });

  app.patch("/feedback/:id/read", requireFeedbackAdmin, async (c) => {
    const ok = await markFeedbackRead(dbOf(c), c.req.param("id"));
    if (!ok) {
      throw new DubError("NOTIF_FEEDBACK_NOT_FOUND", `feedback not found: ${c.req.param("id")}`, { status: 404 });
    }
    return c.json({ ok: true });
  });

  return app;
}

// requireAuth middleware backed by a per-request auth client (trustedHeader mode).
const authOnly: MiddlewareHandler<AppBindings> = async (c, next) => {
  const client = createAuthClient({ identityBinding: c.env.SVC_IDENTITY, serviceName: SERVICE_NAME });
  c.set("authClient", client);
  return client.requireAuth()(c, next);
};

// Admin gate for the feedback read surface. Runs AFTER authOnly (which sets authClient
// + authn), so it reuses that per-request client to check notif:admin (identity /authz/check).
const requireFeedbackAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const client = c.get("authClient");
  return client.requirePermission(FEEDBACK_ADMIN_PERMISSION)(c, next);
};

// Admin gate for publishing release notes (POST /release). Runs AFTER authOnly, reusing
// its per-request auth client to check notif:admin (identity /authz/check).
const requireReleaseAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const client = c.get("authClient");
  return client.requirePermission(RELEASE_ADMIN_PERMISSION)(c, next);
};
