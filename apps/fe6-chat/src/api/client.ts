/// <reference lib="dom" />
// ChatApiClient — the HTTP surface FE6 depends on. All calls go through
// api-gateway `/api/v1/chat/*` (design §2-4). In the real SPA this is backed by
// FE2's `chat: ResourceClient` (theme5 1-2-7); here we ship a fetch-based impl and
// an in-memory mock (mock-client.ts) so the unit is complete without chat-service.
import type { common, identity } from "@dub/types";
import { isErrorResponse, type ErrorResponse } from "@dub/errors";
import type {
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
} from "./contract";

export interface ChatApiClient {
  listChannels(eventId?: common.EventId): Promise<Channel[]>;
  createChannel(req: CreateChannelRequest): Promise<Channel>;
  getChannel(id: common.ChannelId): Promise<GetChannelResponse>;
  updateChannel(id: common.ChannelId, req: UpdateChannelRequest): Promise<Channel>;
  addMember(id: common.ChannelId, userId: common.UserId, role?: ChannelMember["role"]): Promise<ChannelMember>;
  removeMember(id: common.ChannelId, userId: common.UserId): Promise<void>;
  listMembers(id: common.ChannelId): Promise<ChannelMember[]>;
  searchMessages(req: SearchMessagesRequest): Promise<SearchHit[]>;
  listPinned(id: common.ChannelId): Promise<Message[]>;
  togglePin(id: common.ChannelId, messageId: common.MessageId): Promise<Message[]>;
  listMessages(req: ListMessagesRequest): Promise<ListMessagesResponse>;
  postMessage(req: PostMessageRequest): Promise<PostMessageResponse>;
  editMessage(id: common.MessageId, req: EditMessageRequest): Promise<Message>;
  deleteMessage(id: common.MessageId): Promise<Message>;
  toggleReaction(id: common.MessageId, req: ReactionToggleRequest): Promise<Message>;
  updateReadState(req: ReadStateUpdateRequest): Promise<void>;
  listUnread(): Promise<UnreadSummary[]>; // subject from auth header — no ?userId= (chat review #10/#13)
  getWsTicket(id: common.ChannelId): Promise<WsTicketResponse>;
  resolveUsers(ids: common.UserId[]): Promise<identity.UserSummary[]>; // batch ≤50 (theme2 B1)
}

/** Error carrying the @dub/errors wire body so callers can map codes to UI. */
export class ChatApiError extends Error {
  readonly status: number;
  readonly body: ErrorResponse | null;
  constructor(status: number, body: ErrorResponse | null) {
    super(body?.error.message ?? `HTTP ${status}`);
    this.name = "ChatApiError";
    this.status = status;
    this.body = body;
  }
  get code(): string {
    return this.body?.error.code ?? "INTERNAL";
  }
}

export interface HttpChatClientOptions {
  baseUrl?: string; // gateway origin; defaults to same-origin
  fetchImpl?: typeof fetch;
}

const API = "/api/v1";
const CHAT = `${API}/chat`;
const IDENTITY = `${API}/identity`;
const IDENTITY_BATCH_MAX = 50;

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/**
 * Normalize a list response to a plain array. chat-service (and identity /users)
 * return the frozen `common.Paginated<T>` envelope `{ items, nextCursor }` for
 * channels / unread / user-resolution, whereas the mock server and a few other
 * endpoints (members, pins, search) return a bare array. Downstream code does
 * `for..of` / spread / `.find` on these results, so a non-iterable envelope object
 * crashes the whole app with "e is not iterable" (chat error-fix). Accept either
 * shape — and null/undefined — and always hand back an array.
 */
function unwrapItems<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  if (res && typeof res === "object" && Array.isArray((res as { items?: unknown }).items)) {
    return (res as { items: T[] }).items;
  }
  return [];
}

/** fetch-based client. Cookie session (Web) travels via credentials: "include". */
export class HttpChatClient implements ChatApiClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpChatClientOptions = {}) {
    this.base = opts.baseUrl ?? "";
    // Bind to the global (window/globalThis) — a bare `fetch` reference called as
    // `this.fetchImpl(...)` runs with `this === client`, which native fetch rejects
    // with "Illegal invocation", so live-mode requests never leave the client.
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      credentials: "include",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let parsed: ErrorResponse | null = null;
      try {
        const json: unknown = await res.json();
        if (isErrorResponse(json)) parsed = json;
      } catch {
        // non-JSON error body — leave null
      }
      throw new ChatApiError(res.status, parsed);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async listChannels(eventId?: common.EventId): Promise<Channel[]> {
    // Server returns common.Paginated<Channel> ({ items, nextCursor }); unwrap to array.
    const res = await this.request<unknown>("GET", `${CHAT}/channels${qs({ eventId })}`);
    return unwrapItems<Channel>(res);
  }
  createChannel(req: CreateChannelRequest): Promise<Channel> {
    return this.request<Channel>("POST", `${CHAT}/channels`, req);
  }
  getChannel(id: common.ChannelId): Promise<GetChannelResponse> {
    return this.request<GetChannelResponse>("GET", `${CHAT}/channels/${id}`);
  }
  updateChannel(id: common.ChannelId, req: UpdateChannelRequest): Promise<Channel> {
    return this.request<Channel>("PATCH", `${CHAT}/channels/${id}`, req);
  }
  addMember(id: common.ChannelId, userId: common.UserId, role: ChannelMember["role"] = "member"): Promise<ChannelMember> {
    return this.request<ChannelMember>("POST", `${CHAT}/channels/${id}/members`, { userId, role });
  }
  removeMember(id: common.ChannelId, userId: common.UserId): Promise<void> {
    return this.request<void>("DELETE", `${CHAT}/channels/${id}/members/${userId}`);
  }
  listMembers(id: common.ChannelId): Promise<ChannelMember[]> {
    return this.request<ChannelMember[]>("GET", `${CHAT}/channels/${id}/members`);
  }
  searchMessages(req: SearchMessagesRequest): Promise<SearchHit[]> {
    return this.request<SearchHit[]>("GET", `${CHAT}/search${qs({ q: req.q, channelId: req.channelId, limit: req.limit })}`);
  }
  listPinned(id: common.ChannelId): Promise<Message[]> {
    return this.request<Message[]>("GET", `${CHAT}/channels/${id}/pins`);
  }
  togglePin(id: common.ChannelId, messageId: common.MessageId): Promise<Message[]> {
    return this.request<Message[]>("POST", `${CHAT}/channels/${id}/pins`, { messageId });
  }
  listMessages(req: ListMessagesRequest): Promise<ListMessagesResponse> {
    const { channelId, cursor, limit, threadRootId, afterMessageId } = req;
    return this.request<ListMessagesResponse>(
      "GET",
      `${CHAT}/messages${qs({ channelId, cursor, limit, threadRootId, afterMessageId })}`,
    );
  }
  postMessage(req: PostMessageRequest): Promise<PostMessageResponse> {
    return this.request<PostMessageResponse>("POST", `${CHAT}/messages`, req);
  }
  editMessage(id: common.MessageId, req: EditMessageRequest): Promise<Message> {
    return this.request<Message>("PATCH", `${CHAT}/messages/${id}`, req);
  }
  deleteMessage(id: common.MessageId): Promise<Message> {
    return this.request<Message>("DELETE", `${CHAT}/messages/${id}`);
  }
  toggleReaction(id: common.MessageId, req: ReactionToggleRequest): Promise<Message> {
    return this.request<Message>("POST", `${CHAT}/messages/${id}/reactions`, req);
  }
  updateReadState(req: ReadStateUpdateRequest): Promise<void> {
    return this.request<void>("POST", `${CHAT}/channels/${req.channelId}/read`, req);
  }
  async listUnread(): Promise<UnreadSummary[]> {
    // Server returns { items: UnreadSummary[] } (UnreadResponse); unwrap to array.
    const res = await this.request<unknown>("GET", `${CHAT}/unread`);
    return unwrapItems<UnreadSummary>(res);
  }
  getWsTicket(id: common.ChannelId): Promise<WsTicketResponse> {
    return this.request<WsTicketResponse>("GET", `${CHAT}/channels/${id}/ws-ticket`);
  }
  async resolveUsers(ids: common.UserId[]): Promise<identity.UserSummary[]> {
    if (ids.length === 0) return [];
    const batch = ids.slice(0, IDENTITY_BATCH_MAX);
    // identity /users returns common.Paginated<UserSummary> ({ items, nextCursor }); unwrap to array.
    const res = await this.request<unknown>("GET", `${IDENTITY}/users${qs({ ids: batch.join(",") })}`);
    return unwrapItems<identity.UserSummary>(res);
  }
}
