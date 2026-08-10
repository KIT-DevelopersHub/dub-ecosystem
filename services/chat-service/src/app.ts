// Hono app — a thin HTTP adapter over ChatService. Routing matches the gateway
// mount: /api/v1/chat/* targets this Worker (gateway strips API_PREFIX + /chat).
// WS is NOT served here (DO-direct, gateway-bypassing); clients use the doUrl from
// GET /channels/:id/ws-ticket. POST /internal/system-messages is internal-only.
import { Hono } from "hono";
import type { Context } from "hono";
import { dubContext, DUB_HEADERS, INTERNAL_MARKER, type RequestContext } from "@dub/http";
import { dubErrorHandler, errors } from "@dub/errors";
import type {
  AppDeps,
  AddMemberRequest,
  CreateChannelRequest,
  MarkUnreadRequest,
  PinMessageRequest,
  PostMessageRequest,
  PostSystemMessageRequest,
  ReactionToggleRequest,
  ReadStateUpdateRequest,
  SetPresenceRequest,
  UpdateChannelRequest,
} from "./types";
import { ChatService, type ReqCtx } from "./service";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getDubCtx(c: Context): RequestContext | undefined {
  return (c as any).get("dubCtx") as RequestContext | undefined;
}

function reqCtx(c: Context): ReqCtx {
  const ctx = getDubCtx(c);
  const requestId = ctx?.requestId ?? c.req.header(DUB_HEADERS.requestId) ?? "";
  const userId = ctx?.userId ?? c.req.header(DUB_HEADERS.userId);
  if (!userId) throw errors.unauthenticated("x-dub-user-id absent");
  return { requestId, userId };
}

function qNum(v: string | undefined, field = "limit"): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw errors.validationFailed([{ field, reason: "invalid" }]);
  return n;
}

async function readJson<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw errors.validationFailed([{ field: "body", reason: "invalid_json" }]);
  }
}

export function createApp(deps: AppDeps): Hono {
  const svc = new ChatService(deps);
  const app = new Hono();

  app.onError(dubErrorHandler({ service: "chat-service" }));
  app.use("*", dubContext({ allowGenerate: true }));

  app.get("/health", (c) => c.json({ status: "ok", service: "chat-service" }));

  // ---- internal (gateway internalOnlyPaths -> 404 externally; second defence
  // here: the x-dub-internal marker must be present, else 404 to hide it). ----
  app.post("/internal/system-messages", async (c) => {
    if (c.req.header(DUB_HEADERS.internal) !== INTERNAL_MARKER) throw errors.notFound("route");
    const ctx = getDubCtx(c);
    const requestId = ctx?.requestId ?? c.req.header(DUB_HEADERS.requestId) ?? "";
    const body = await readJson<PostSystemMessageRequest>(c);
    const created = await svc.postSystemMessage({ requestId }, body);
    return c.json(created, 201);
  });

  const { authz } = deps;

  // Auth on all user-facing groups (internal + health excluded).
  app.use("/channels", authz.requireAuth());
  app.use("/channels/*", authz.requireAuth());
  app.use("/messages", authz.requireAuth());
  app.use("/messages/*", authz.requireAuth());
  app.use("/unread", authz.requireAuth());
  app.use("/search", authz.requireAuth());
  app.use("/presence", authz.requireAuth());

  // ---- channels ----
  app.get("/channels", async (c) => {
    const q = c.req.query();
    return c.json(
      await svc.listChannels(reqCtx(c), {
        ...(q.cursor ? { cursor: q.cursor } : {}),
        ...(q.limit !== undefined ? { limit: qNum(q.limit) } : {}),
        ...(q.eventId ? { eventId: q.eventId } : {}),
      }),
    );
  });

  app.post("/channels", authz.requirePermission("chat:create"), async (c) => {
    const body = await readJson<CreateChannelRequest>(c);
    return c.json(await svc.createChannel(reqCtx(c), body), 201);
  });

  app.get("/channels/:id", async (c) => {
    return c.json(await svc.getChannel(reqCtx(c), c.req.param("id")));
  });

  app.patch("/channels/:id", async (c) => {
    const body = await readJson<UpdateChannelRequest>(c);
    return c.json(await svc.updateChannel(reqCtx(c), c.req.param("id"), body));
  });

  app.post("/channels/:id/members", async (c) => {
    const body = await readJson<AddMemberRequest>(c);
    await svc.addMember(reqCtx(c), c.req.param("id"), body);
    return c.body(null, 204);
  });

  app.delete("/channels/:id/members/:userId", async (c) => {
    await svc.removeMember(reqCtx(c), c.req.param("id"), c.req.param("userId"));
    return c.body(null, 204);
  });

  app.post("/channels/:id/read", async (c) => {
    const body = await readJson<ReadStateUpdateRequest>(c);
    // path id is authoritative for the channel scope
    return c.json(await svc.updateReadState(reqCtx(c), c.req.param("id"), { ...body, channelId: c.req.param("id") }));
  });

  app.post("/channels/:id/mark-unread", async (c) => {
    const body = await readJson<MarkUnreadRequest>(c);
    return c.json(await svc.markUnread(reqCtx(c), c.req.param("id"), body));
  });

  app.post("/channels/:id/join", async (c) => {
    return c.json(await svc.joinChannel(reqCtx(c), c.req.param("id")));
  });

  // ---- pins ----
  app.get("/channels/:id/pins", async (c) => {
    return c.json(await svc.listPins(reqCtx(c), c.req.param("id")));
  });

  app.post("/channels/:id/pins", async (c) => {
    const body = await readJson<PinMessageRequest>(c);
    return c.json(await svc.pinMessage(reqCtx(c), c.req.param("id"), body), 201);
  });

  app.delete("/channels/:id/pins/:messageId", async (c) => {
    await svc.unpinMessage(reqCtx(c), c.req.param("id"), c.req.param("messageId"));
    return c.body(null, 204);
  });

  app.get("/channels/:id/ws-ticket", async (c) => {
    return c.json(await svc.issueWsTicket(reqCtx(c), c.req.param("id")));
  });

  // ---- messages ----
  app.get("/messages", async (c) => {
    const q = c.req.query();
    const channelId = q.channelId;
    if (!channelId) throw errors.validationFailed([{ field: "channelId", reason: "required" }]);
    return c.json(
      await svc.listMessages(reqCtx(c), {
        channelId,
        ...(q.cursor ? { cursor: q.cursor } : {}),
        ...(q.limit !== undefined ? { limit: qNum(q.limit) } : {}),
        ...(q.threadRootId ? { threadRootId: q.threadRootId } : {}),
        ...(q.afterMessageId ? { afterMessageId: q.afterMessageId } : {}),
      }),
    );
  });

  app.post("/messages", async (c) => {
    const body = await readJson<PostMessageRequest>(c);
    return c.json(await svc.postMessage(reqCtx(c), body), 201);
  });

  app.patch("/messages/:id", async (c) => {
    const body = await readJson<{ version?: number; body?: string }>(c);
    return c.json(await svc.editMessage(reqCtx(c), c.req.param("id"), body));
  });

  app.delete("/messages/:id", async (c) => {
    await svc.deleteMessage(reqCtx(c), c.req.param("id"));
    return c.body(null, 204);
  });

  app.post("/messages/:id/reactions", async (c) => {
    const body = await readJson<ReactionToggleRequest>(c);
    return c.json(await svc.toggleReaction(reqCtx(c), c.req.param("id"), body.emoji));
  });

  // ---- unread (caller-scoped; no userId param, design §2) ----
  app.get("/unread", async (c) => {
    return c.json(await svc.unread(reqCtx(c)));
  });

  // ---- search (Slack in:/from: — full-text over the caller's channels) ----
  app.get("/search", async (c) => {
    const q = c.req.query();
    if (!q.q) throw errors.validationFailed([{ field: "q", reason: "required" }]);
    return c.json(
      await svc.searchMessages(reqCtx(c), {
        q: q.q,
        ...(q.in ? { in: q.in } : {}),
        ...(q.from ? { from: q.from } : {}),
        ...(q.cursor ? { cursor: q.cursor } : {}),
        ...(q.limit !== undefined ? { limit: qNum(q.limit) } : {}),
      }),
    );
  });

  // ---- presence (self write; batch read via ?userIds=a,b,c) ----
  app.put("/presence", async (c) => {
    const body = await readJson<SetPresenceRequest>(c);
    return c.json(await svc.setPresence(reqCtx(c), body));
  });

  app.get("/presence", async (c) => {
    const raw = c.req.query("userIds");
    if (!raw) throw errors.validationFailed([{ field: "userIds", reason: "required" }]);
    const userIds = raw.split(",").map((s) => s.trim()).filter(Boolean);
    return c.json(await svc.getPresence(reqCtx(c), userIds));
  });

  return app;
}
