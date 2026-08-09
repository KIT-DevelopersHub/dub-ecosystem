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
  listPreferenceOverrides,
  upsertPreference,
  deletePreference,
} from "./repo";
import { mergedView, defaultEnabled } from "./preferences";
import {
  parseNotifyRequest,
  parseListInboxQuery,
  parseReadAll,
  parsePreferencesUpdate,
} from "./validation";
import type { IngestInput } from "./types";

interface GetPreferencesResponse {
  userId: string;
  entries: notification.PreferenceEntry[];
}
interface NotifyResponse {
  notificationId: string;
  deduplicated: boolean;
}

export function createApp() {
  const app = new Hono<AppBindings>();

  app.onError(dubErrorHandler({ service: SERVICE_NAME }));
  app.use("*", dubContext({ allowGenerate: true }));

  const ctxOf = (c: Context<AppBindings>): RequestContext => c.get("dubCtx");
  const dbOf = (c: Context<AppBindings>) => buildDb(c.env, ctxOf(c).requestId);

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

  // ---- self-scoped routes: requireAuth (trusted header -> x-dub-user-id = 本人).
  // No requirePermission: notif:inbox:self / notif:prefs:self are not in the frozen
  // PERMISSION_CATALOG; self-access is enforced by scoping every query to userId.
  app.use("/inbox/*", authOnly);
  app.use("/inbox", authOnly);
  app.use("/preferences", authOnly);

  app.get("/inbox", async (c) => {
    const userId = getUserId(c);
    const q = parseListInboxQuery(c.req.query());
    const page = await listInbox(dbOf(c), userId, q);
    return c.json(page satisfies notification.ListInboxResponse);
  });

  app.get("/inbox/unread-count", async (c) => {
    const userId = getUserId(c);
    const count = await unreadCount(dbOf(c), userId);
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

  return app;
}

// requireAuth middleware backed by a per-request auth client (trustedHeader mode).
const authOnly: MiddlewareHandler<AppBindings> = async (c, next) => {
  const client = createAuthClient({ identityBinding: c.env.SVC_IDENTITY, serviceName: SERVICE_NAME });
  c.set("authClient", client);
  return client.requireAuth()(c, next);
};
