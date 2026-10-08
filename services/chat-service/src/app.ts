// Hono app — a thin HTTP adapter over ChatService. Routing matches the gateway
// mount: api-gateway strips ONLY API_PREFIX (/api/v1) and PRESERVES the segment, so
// /api/v1/chat/* reaches this Worker as /chat/* — the user-facing routes therefore live
// under /chat (mirrors identity-roster's /identity, member-service's /members). /health
// and the internal service-binding surface (/internal/system-messages) stay at bare paths
// (addressed directly by callers, NOT through the gateway). WS is NOT served here
// (DO-direct, gateway-bypassing); clients use the doUrl from GET /chat/channels/:id/ws-ticket.
//
// AUTHZ — the PERMISSION-KEY half lives in src/policy-table.ts and nowhere else: `policyGate`
// is mounted once below and every route in this file is listed there (a route that is not is
// denied, and test/policy-table.test.ts fails). It replaced the per-group
// `authz.requireAuth()` mounts, the two `authz.requirePermission(...)` route middlewares, and
// the hand-rolled "x-dub-internal or 404" guard on /internal/system-messages.
//
// What did NOT move, and must not: the CHANNEL-scoped half. `loadReadable` (private +
// non-member -> 404), `ensureCanWrite` (public auto-join / private 403), `isChannelAdmin`,
// author-only edit and author-or-moderator delete all stay in ChatService, because they need
// request data (which channel? is the caller a member of it?) that the gate deliberately
// cannot see. Dropping them would turn `app:chat:view` — a key an ordinary member holds —
// into read access to every private channel in the org. See src/policy-table.ts's header.
import { Hono } from "hono";
import type { Context } from "hono";
import { dubContext, DUB_HEADERS, type RequestContext } from "@dub/http";
import { policyGate, type PolicyGateVars } from "@dub/policy-gate";
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
  UpdateDeletionPolicyRequest,
} from "./types";
import { ChatService, type ReqCtx } from "./service";
import { POLICY_TABLE } from "./policy-table";
import { validateUnfurlUrl, UNFURL_CACHE_TTL_SECONDS, type UnfurlResponse } from "./unfurl";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getDubCtx(c: Context): RequestContext | undefined {
  return (c as any).get("dubCtx") as RequestContext | undefined;
}

// Request plumbing, NOT an authorization check: the correlation id plus the acting user.
// `policyGate` has already established the actor on every keyed route (and published it as
// `userId`) from the same trusted `x-dub-user-id` header read below, so the 401 here is
// belt-and-braces — it only really fires on the INTERNAL route, where a calling service may
// legitimately have propagated no user at all.
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

type Vars = PolicyGateVars;

export function createApp(deps: AppDeps): Hono<{ Variables: Vars }> {
  const svc = new ChatService(deps);
  const app = new Hono<{ Variables: Vars }>();

  app.onError(dubErrorHandler({ service: "chat-service" }));
  // Pure x-dub-* header parsing — it makes no authorization decision — and it stays FIRST so
  // the gate's identity /authz/check subrequest carries this request's correlation id.
  app.use("*", dubContext({ allowGenerate: true }));

  // ---- THE authorization layer: mounted on every route, so it runs before every handler,
  // including the ones registered below it. A route absent from POLICY_TABLE is denied (403),
  // never served. Note the mount is `"*"` (wildcard) rather than a set of exact-path `use`
  // mounts like the requireAuth() group mounts it replaced: Hono records `use("/chat/search",
  // mw)` as `ALL /chat/search`, indistinguishable from a real endpoint, so an exact-path
  // `use` would show up in the coverage test as a route with no rule. Per-route middleware or
  // a wildcard mount — never an exact-path `use` — in a gated service. ----
  app.use("*", policyGate({ service: "chat-service", table: POLICY_TABLE, granted: deps.authz }));

  app.get("/health", (c) => c.json({ status: "ok", service: "chat-service" }));

  // ---- internal: INTERNAL in POLICY_TABLE (the x-dub-internal marker, which api-gateway
  // strips off every external request, so it cannot be forged). The gateway's own
  // internalOnlyPaths still answers 404 at the edge; the gate's refusal here is 403. ----
  app.post("/internal/system-messages", async (c) => {
    const ctx = getDubCtx(c);
    const requestId = ctx?.requestId ?? c.req.header(DUB_HEADERS.requestId) ?? "";
    const body = await readJson<PostSystemMessageRequest>(c);
    const created = await svc.postSystemMessage({ requestId }, body);
    return c.json(created, 201);
  });

  // ---- link preview (OGP unfurl) ----
  // Key-gated by POLICY_TABLE (never an anonymous fetch proxy). The URL is validated fail-close
  // (http(s), public hosts only) BEFORE any outbound request; the resolver itself
  // re-validates every redirect hop. Results are cached 1 day (Cache API, keyed by
  // the normalized URL) so a channel re-rendering the same link does not refetch.
  app.get("/chat/unfurl", async (c) => {
    reqCtx(c); // 401 without a subject
    const target = validateUnfurlUrl(c.req.query("url") ?? "");
    if (!target) throw errors.validationFailed([{ field: "url", reason: "invalid_or_blocked" }]);
    const url = target.toString();
    const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
    const cacheKey = new Request(`https://chat-service.internal/unfurl?url=${encodeURIComponent(url)}`);
    const hit = await cache?.match(cacheKey).catch(() => undefined);
    if (hit) return hit;
    const preview = deps.unfurler ? await deps.unfurler(url) : null;
    const body: UnfurlResponse = { url, preview };
    const res = c.json(body);
    // The Cache API refuses (413) to store a `private` response, which would silently
    // turn the 1-day cache into a no-op. OGP data is public and the key excludes the
    // user, so the stored copy is `public`; the client still gets `private`.
    res.headers.set("cache-control", `public, max-age=${UNFURL_CACHE_TTL_SECONDS}`);
    if (cache) await cache.put(cacheKey, res.clone()).catch(() => undefined);
    res.headers.set("cache-control", `private, max-age=${UNFURL_CACHE_TTL_SECONDS}`);
    return res;
  });

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

  app.post("/chat/channels", async (c) => {
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
    // Returns { mode, message }: `hard` -> message null (row gone, client drops it);
    // `tombstone` -> the redacted message (client renders "削除されました").
    return c.json(await svc.deleteMessage(reqCtx(c), c.req.param("id")));
  });

  app.post("/chat/messages/:id/reactions", async (c) => {
    const body = await readJson<ReactionToggleRequest>(c);
    return c.json(await svc.toggleReaction(reqCtx(c), c.req.param("id"), body.emoji));
  });

  // ---- unread (caller-scoped; no userId param, design §2) ----
  app.get("/chat/unread", async (c) => {
    return c.json(await svc.unread(reqCtx(c)));
  });

  // ---- settings: message deletion policy (RBAC-configurable delete behaviour) ----
  // Reading needs チャット=閲覧 (the FE renders the policy section from it); writing needs
  // 編集 + chat:moderate (admin/maintainer). Both rules are in POLICY_TABLE, fail-close.
  app.get("/chat/settings/deletion-policy", async (c) => {
    return c.json(await svc.getDeletionPolicy(reqCtx(c)));
  });
  app.patch("/chat/settings/deletion-policy", async (c) => {
    const body = await readJson<UpdateDeletionPolicyRequest>(c);
    return c.json(await svc.updateDeletionPolicy(reqCtx(c), body));
  });

  return app;
}
