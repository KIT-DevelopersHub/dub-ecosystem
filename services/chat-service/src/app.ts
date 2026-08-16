// Hono app — a thin HTTP adapter over ChatService. Routing matches the gateway
// mount: api-gateway strips ONLY API_PREFIX (/api/v1) and PRESERVES the segment, so
// /api/v1/chat/* reaches this Worker as /chat/* — the user-facing routes therefore live
// under /chat (mirrors identity-roster's /identity, member-service's /members). /health
// and the internal service-binding surface (/internal/system-messages) stay at bare paths
// (addressed directly by callers, NOT through the gateway). WS is NOT served here
// (DO-direct, gateway-bypassing); clients use the doUrl from GET /chat/channels/:id/ws-ticket.
import { Hono } from "hono";
import type { Context } from "hono";
import { dubContext, DUB_HEADERS, INTERNAL_MARKER, type RequestContext } from "@dub/http";
import { dubErrorHandler, errors } from "@dub/errors";
import type {
  AppDeps,
  AddMemberRequest,
  CreateChannelRequest,
  PinToggleRequest,
  PostMessageRequest,
  PostSystemMessageRequest,
  ReactionToggleRequest,
  ReadStateUpdateRequest,
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

  // Auth on all user-facing groups (internal + health excluded). These live under
  // /chat because the gateway preserves the segment (see file header).
  app.use("/chat/channels", authz.requireAuth());
  app.use("/chat/channels/*", authz.requireAuth());
  app.use("/chat/messages", authz.requireAuth());
  app.use("/chat/messages/*", authz.requireAuth());
  app.use("/chat/unread", authz.requireAuth());
  app.use("/chat/search", authz.requireAuth());

  // ---- channels ----
  app.get("/chat/channels", async (c) => {
    const q = c.req.query();
    return c.json(
      await svc.listChannels(reqCtx(c), {
        ...(q.cursor ? { cursor: q.cursor } : {}),
        ...(q.limit !== undefined ? { limit: qNum(q.limit) } : {}),
        ...(q.eventId ? { eventId: q.eventId } : {}),
      }),
    );
  });

  app.post("/chat/channels", authz.requirePermission("chat:create"), async (c) => {
    const body = await readJson<CreateChannelRequest>(c);
    return c.json(await svc.createChannel(reqCtx(c), body), 201);
  });

  app.get("/chat/channels/:id", async (c) => {
    return c.json(await svc.getChannel(reqCtx(c), c.req.param("id")));
  });

  app.patch("/chat/channels/:id", async (c) => {
    const body = await readJson<UpdateChannelRequest>(c);
    return c.json(await svc.updateChannel(reqCtx(c), c.req.param("id"), body));
  });

  app.get("/chat/channels/:id/members", async (c) => {
    return c.json(await svc.listMembers(reqCtx(c), c.req.param("id")));
  });

  app.post("/chat/channels/:id/members", async (c) => {
    const body = await readJson<AddMemberRequest>(c);
    await svc.addMember(reqCtx(c), c.req.param("id"), body);
    return c.body(null, 204);
  });

  app.delete("/chat/channels/:id/members/:userId", async (c) => {
    await svc.removeMember(reqCtx(c), c.req.param("id"), c.req.param("userId"));
    return c.body(null, 204);
  });

  // ---- pins (Slack-parity) ----
  app.get("/chat/channels/:id/pins", async (c) => {
    return c.json(await svc.listPins(reqCtx(c), c.req.param("id")));
  });

  app.post("/chat/channels/:id/pins", async (c) => {
    const body = await readJson<PinToggleRequest>(c);
    return c.json(await svc.togglePin(reqCtx(c), c.req.param("id"), body.messageId));
  });

  app.post("/chat/channels/:id/read", async (c) => {
    const body = await readJson<ReadStateUpdateRequest>(c);
    // path id is authoritative for the channel scope
    return c.json(await svc.updateReadState(reqCtx(c), c.req.param("id"), { ...body, channelId: c.req.param("id") }));
  });

  app.get("/chat/channels/:id/ws-ticket", async (c) => {
    return c.json(await svc.issueWsTicket(reqCtx(c), c.req.param("id")));
  });

  // ---- search (Slack-parity workspace / channel search) ----
  app.get("/chat/search", async (c) => {
    const q = c.req.query();
    return c.json(
      await svc.search(reqCtx(c), {
        ...(q.q !== undefined ? { q: q.q } : {}),
        ...(q.channelId ? { channelId: q.channelId } : {}),
        ...(q.limit !== undefined ? { limit: qNum(q.limit) } : {}),
      }),
    );
  });

  // ---- messages ----
  app.get("/chat/messages", async (c) => {
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

  app.post("/chat/messages", async (c) => {
    const body = await readJson<PostMessageRequest>(c);
    return c.json(await svc.postMessage(reqCtx(c), body), 201);
  });

  app.patch("/chat/messages/:id", async (c) => {
    const body = await readJson<{ version?: number; body?: string }>(c);
    return c.json(await svc.editMessage(reqCtx(c), c.req.param("id"), body));
  });

  app.delete("/chat/messages/:id", async (c) => {
    await svc.deleteMessage(reqCtx(c), c.req.param("id"));
    return c.body(null, 204);
  });

  app.post("/chat/messages/:id/reactions", async (c) => {
    const body = await readJson<ReactionToggleRequest>(c);
    return c.json(await svc.toggleReaction(reqCtx(c), c.req.param("id"), body.emoji));
  });

  // ---- unread (caller-scoped; no userId param, design §2) ----
  app.get("/chat/unread", async (c) => {
    return c.json(await svc.unread(reqCtx(c)));
  });

  return app;
}
