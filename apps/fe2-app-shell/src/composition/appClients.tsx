// Composition · app-facing client adapters (W7a).
//
// FE3–FE7 each declared their own *local* stand-in for the FE2 gateway client
// (HttpClient / ApiClient / ResourceClient), all shaped slightly differently
// because @dub/api-client had not landed when they were written. This module is
// the single place that bridges the ONE real client (src/lib/api-client.tsx
// `ApiClient` / `ResourceClient`) to each feature's expected surface, so every
// FeatureModule below is genuinely fed by the shell's api-client — not a mock.
//
// Path convention: the FE2 ApiClient.request takes an absolute `/api/v1/...`
// path (it owns baseUrl, cookie session, 401→refresh, requestId, retry, error
// normalization). Adapters here translate each feature's path style onto it.
import type { ApiClient } from "../lib/api-client.tsx";
import type { EventApi } from "@dub/fe3-event-action";
import { createHttpEventApi } from "@dub/fe3-event-action";
import type { NotificationApi } from "@dub/fe5-notification-inbox";
import { createNotificationApi } from "@dub/fe5-notification-inbox";
import { createRosterApi } from "@dub/admin-roster";
// FE4/FE6 deep-import surface via the single boundary (featureEntries.tsx).
import type {
  Fe4ApiClient,
  ChatApiClient,
  Channel,
  ChannelMember,
  CreateChannelRequest,
  EditMessageRequest,
  GetChannelResponse,
  ListMessagesRequest,
  ListMessagesResponse,
  Message,
  PostMessageRequest,
  PostMessageResponse,
  ReactionToggleRequest,
  ReadStateUpdateRequest,
  SearchHit,
  SearchMessagesRequest,
  UnreadSummary,
  UpdateChannelRequest,
  WsTicketResponse,
} from "./featureEntries.tsx";
import type { common, identity } from "@dub/types";

type ApiPath = `/api/v1/${string}`;
type QueryValue = string | number | boolean | undefined;
type Query = Record<string, QueryValue>;

/** Narrow an arbitrary query bag to the request layer's accepted value types. */
function normalizeQuery(query?: Record<string, unknown>): Query | undefined {
  if (!query) return undefined;
  const out: Query = {};
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : String(v);
  }
  return out;
}

// ── FE3: HttpClient (logical paths, client absorbs the /api/v1 prefix) ───────
/** Shape of the client FE3's `createHttpEventApi` consumes (`del`, not delete). */
export interface Fe3HttpClient {
  get<T>(path: string, query?: Record<string, unknown>): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  del<T>(path: string, body?: unknown): Promise<T>;
}

export function createPrefixedHttpClient(api: ApiClient): Fe3HttpClient {
  const p = (path: string): ApiPath => `/api/v1${path.startsWith("/") ? path : `/${path}`}` as ApiPath;
  return {
    get: <T,>(path: string, query?: Record<string, unknown>) => {
      const q = normalizeQuery(query);
      return api.request<T>({ method: "GET", path: p(path), ...(q ? { query: q } : {}) });
    },
    post: <T,>(path: string, body: unknown) => api.request<T>({ method: "POST", path: p(path), body }),
    patch: <T,>(path: string, body: unknown) => api.request<T>({ method: "PATCH", path: p(path), body }),
    del: <T,>(path: string, body?: unknown) =>
      api.request<T>({ method: "DELETE", path: p(path), ...(body !== undefined ? { body } : {}) }),
  };
}

// FE3's createHttpEventApi now consumes the FE2 ApiClient contract directly
// (contracts/fe2.ApiClient), a structural mirror of the shell ApiClient — so the
// shell client is handed in as-is. (createPrefixedHttpClient is retained above as
// a standalone logical-path helper + is covered by the composition tests.)
export function createEventApi(api: ApiClient): EventApi {
  return createHttpEventApi(api as unknown as Parameters<typeof createHttpEventApi>[0]);
}

// ── FE5 (ApiClient) & FE7 (ResourceClient): absolute-path gateway client ─────
/** Superset satisfying FE5 `ApiClient` (get/post/patch) and FE7 `ResourceClient`
 *  (get/post/patch/delete→void). Callers pass fully-qualified `/api/v1/...` paths. */
export interface GatewayResourceClient {
  get<T>(path: string, query?: Record<string, unknown>): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  delete(path: string): Promise<void>;
}

export function createGatewayResourceClient(api: ApiClient): GatewayResourceClient {
  return {
    get: <T,>(path: string, query?: Record<string, unknown>) => {
      const q = normalizeQuery(query);
      return api.request<T>({ method: "GET", path: path as ApiPath, ...(q ? { query: q } : {}) });
    },
    post: <T,>(path: string, body?: unknown) =>
      api.request<T>({ method: "POST", path: path as ApiPath, ...(body !== undefined ? { body } : {}) }),
    patch: <T,>(path: string, body?: unknown) =>
      api.request<T>({ method: "PATCH", path: path as ApiPath, ...(body !== undefined ? { body } : {}) }),
    delete: (path: string) => api.request<void>({ method: "DELETE", path: path as ApiPath }),
  };
}

export function createNotificationClient(api: ApiClient): NotificationApi {
  return createNotificationApi(createGatewayResourceClient(api));
}

export function createRosterClient(api: ApiClient): ReturnType<typeof createRosterApi> {
  return createRosterApi(createGatewayResourceClient(api));
}

// ── FE4: shell ApiClient ─────────────────────────────────────────────────────
// FE4's spa-shell `ApiClient` contract converged onto the full FE2 ApiClient
// surface (request + auth/bff/events/tasks/gantt/notifications/chat/identity/files),
// a structural mirror of the shell client — so it is handed in as-is.
export function createTaskApiClient(api: ApiClient): Fe4ApiClient {
  return api as unknown as Fe4ApiClient;
}

// ── FE6: ChatApiClient over the shell request layer ──────────────────────────
// FE6 ships an HttpChatClient (its own fetch) for standalone dev; in the shell
// chat must ride the same api-client transport (session/refresh/requestId), so
// this adapter re-expresses FE6's REST map onto `api.request`. Endpoint paths
// mirror FE6's HttpChatClient — keep in sync until FE6 exports a
// ResourceClient-backed factory (cross-PR: fe6-chat).
const CHAT = "/api/v1/chat";
const IDENTITY = "/api/v1/identity";
const IDENTITY_BATCH_MAX = 50;

// chat-service (and identity /users) return the frozen `common.Paginated<T>` envelope
// `{ items, nextCursor }` for channels / unread / user-resolution, whereas a few other
// endpoints return a bare array. FE6's own HttpChatClient unwraps these via the same
// helper — this shell mirror MUST too, or a list result arrives as a non-array envelope
// object and silently renders EMPTY (groupChannels drops a non-array via its guard),
// e.g. the channel sidebar shows nothing even though /chat/channels returns 200 with
// items. Accept either shape (+ null/undefined) and always hand back an array.
function unwrapItems<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  if (res && typeof res === "object" && Array.isArray((res as { items?: unknown }).items)) {
    return (res as { items: T[] }).items;
  }
  return [];
}

export function createChatApiClient(api: ApiClient): ChatApiClient {
  return {
    listChannels: (eventId?: common.EventId) =>
      api
        .request<unknown>({ method: "GET", path: `${CHAT}/channels`, ...(eventId ? { query: { eventId } } : {}) })
        .then((r) => unwrapItems<Channel>(r)),
    createChannel: (req: CreateChannelRequest) =>
      api.request<Channel>({ method: "POST", path: `${CHAT}/channels`, body: req }),
    getChannel: (id: common.ChannelId) =>
      api.request<GetChannelResponse>({ method: "GET", path: `${CHAT}/channels/${id}` as ApiPath }),
    updateChannel: (id: common.ChannelId, req: UpdateChannelRequest) =>
      api.request<Channel>({ method: "PATCH", path: `${CHAT}/channels/${id}` as ApiPath, body: req }),
    addMember: (id: common.ChannelId, userId: common.UserId, role?: ChannelMember["role"]) =>
      api.request<ChannelMember>({
        method: "POST",
        path: `${CHAT}/channels/${id}/members` as ApiPath,
        body: { userId, role: role ?? "member" },
      }),
    removeMember: (id: common.ChannelId, userId: common.UserId) =>
      api.request<void>({ method: "DELETE", path: `${CHAT}/channels/${id}/members/${userId}` as ApiPath }),
    listMembers: (id: common.ChannelId) =>
      api.request<ChannelMember[]>({ method: "GET", path: `${CHAT}/channels/${id}/members` as ApiPath }),
    searchMessages: (req: SearchMessagesRequest) => {
      const query = normalizeQuery({ q: req.q, channelId: req.channelId, limit: req.limit });
      return api.request<SearchHit[]>({ method: "GET", path: `${CHAT}/search`, ...(query ? { query } : {}) });
    },
    listPinned: (id: common.ChannelId) =>
      api.request<Message[]>({ method: "GET", path: `${CHAT}/channels/${id}/pins` as ApiPath }),
    togglePin: (id: common.ChannelId, messageId: common.MessageId) =>
      api.request<Message[]>({ method: "POST", path: `${CHAT}/channels/${id}/pins` as ApiPath, body: { messageId } }),
    listMessages: (req: ListMessagesRequest) => {
      const query = normalizeQuery({
        channelId: req.channelId,
        cursor: req.cursor,
        limit: req.limit,
        threadRootId: req.threadRootId,
        afterMessageId: req.afterMessageId,
      });
      return api.request<ListMessagesResponse>({ method: "GET", path: `${CHAT}/messages`, ...(query ? { query } : {}) });
    },
    // The server returns the created Message (bare), but FE6's optimistic layer
    // reconciles by PostMessageResponse = { message, clientTempId }. The client already
    // knows the clientTempId it sent, so compose the envelope here — otherwise
    // res.clientTempId/res.message are undefined and the optimistic entry can never be
    // acked, surfacing as "送信に失敗しました" even though the POST returned 201.
    postMessage: (req: PostMessageRequest) =>
      api
        .request<Message>({ method: "POST", path: `${CHAT}/messages`, body: req })
        .then((message) => ({ message, clientTempId: req.clientTempId })),
    editMessage: (id: common.MessageId, req: EditMessageRequest) =>
      api.request<Message>({ method: "PATCH", path: `${CHAT}/messages/${id}` as ApiPath, body: req }),
    deleteMessage: (id: common.MessageId) =>
      api.request<Message>({ method: "DELETE", path: `${CHAT}/messages/${id}` as ApiPath }),
    toggleReaction: (id: common.MessageId, req: ReactionToggleRequest) =>
      api.request<Message>({ method: "POST", path: `${CHAT}/messages/${id}/reactions` as ApiPath, body: req }),
    updateReadState: (req: ReadStateUpdateRequest) =>
      api.request<void>({ method: "POST", path: `${CHAT}/channels/${req.channelId}/read` as ApiPath, body: req }),
    listUnread: () =>
      api.request<unknown>({ method: "GET", path: `${CHAT}/unread` }).then((r) => unwrapItems<UnreadSummary>(r)),
    getWsTicket: (id: common.ChannelId) =>
      api.request<WsTicketResponse>({ method: "GET", path: `${CHAT}/channels/${id}/ws-ticket` as ApiPath }),
    resolveUsers: (ids: common.UserId[]) => {
      if (ids.length === 0) return Promise.resolve([]);
      const batch = ids.slice(0, IDENTITY_BATCH_MAX);
      return api
        .request<unknown>({
          method: "GET",
          path: `${IDENTITY}/users`,
          query: { ids: batch.join(",") },
        })
        .then((r) => unwrapItems<identity.UserSummary>(r));
    },
  };
}
