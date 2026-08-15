// In-memory ChatApiClient — the Phase0 mock server (design §7). Backs standalone
// dev and unit tests without chat-service. Deterministic, dependency-free.
import type { common, identity } from "@dub/types";
import { newChannelId, newMessageId } from "../lib/ulid";
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
import type { ChatApiClient } from "./client";
import { ChatApiError } from "./client";
import { toggleReactionLocal } from "../store/timeline";

const now = (): common.ISODateTime => new Date().toISOString();

export interface MockSeed {
  currentUserId: common.UserId;
  channels?: Channel[];
  messages?: Message[];
  members?: ChannelMember[];
  users?: identity.UserSummary[];
  pins?: { channelId: common.ChannelId; messageId: common.MessageId }[];
}

export class MockChatClient implements ChatApiClient {
  private channels = new Map<common.ChannelId, Channel>();
  private messages: Message[] = [];
  private members: ChannelMember[] = [];
  private users = new Map<common.UserId, identity.UserSummary>();
  private readState = new Map<common.ChannelId, common.MessageId>();
  private pins = new Map<common.ChannelId, Set<common.MessageId>>();
  private readonly me: common.UserId;
  /** Latency injected per call (ms). 0 = synchronous microtask. */
  latencyMs = 0;
  /** When set, the next mutating call rejects with this error, then resets. */
  nextError: ChatApiError | null = null;

  constructor(seed: MockSeed) {
    this.me = seed.currentUserId;
    for (const c of seed.channels ?? []) this.channels.set(c.id, c);
    this.messages = (seed.messages ?? []).slice().sort((a, b) => (a.id < b.id ? -1 : 1));
    this.members = seed.members ?? [];
    for (const u of seed.users ?? []) this.users.set(u.id, u);
    for (const p of seed.pins ?? []) {
      const set = this.pins.get(p.channelId) ?? new Set<common.MessageId>();
      set.add(p.messageId);
      this.pins.set(p.channelId, set);
    }
  }

  private async settle<T>(value: T): Promise<T> {
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }
    if (this.latencyMs > 0) await new Promise((r) => globalThis.setTimeout(r, this.latencyMs));
    return value;
  }

  async listChannels(eventId?: common.EventId): Promise<Channel[]> {
    const all = [...this.channels.values()];
    return this.settle(eventId ? all.filter((c) => c.eventId === eventId) : all);
  }

  async createChannel(req: CreateChannelRequest): Promise<Channel> {
    const id = newChannelId();
    const channel: Channel = {
      id,
      orgId: "org_devhub",
      type: req.type,
      visibility: req.visibility ?? "public",
      name: req.name,
      topic: req.topic ?? null,
      eventId: req.eventId ?? null,
      archived: false,
      memberCount: 1,
      version: 1,
      createdAt: now(),
      updatedAt: now(),
    };
    this.channels.set(id, channel);
    this.members.push({ channelId: id, userId: this.me, role: "admin", joinedAt: now() });
    return this.settle(channel);
  }

  async getChannel(id: common.ChannelId): Promise<GetChannelResponse> {
    const channel = this.channels.get(id);
    if (!channel) throw new ChatApiError(404, { error: { code: "NOT_FOUND", message: "channel not found", retryable: false } });
    const membership = this.members.find((m) => m.channelId === id && m.userId === this.me) ?? null;
    return this.settle({ channel, membership });
  }

  async updateChannel(id: common.ChannelId, req: UpdateChannelRequest): Promise<Channel> {
    const channel = this.channels.get(id);
    if (!channel) throw new ChatApiError(404, { error: { code: "NOT_FOUND", message: "channel not found", retryable: false } });
    if (channel.version !== req.version) {
      throw new ChatApiError(409, { error: { code: "CHAT_VERSION_CONFLICT", message: "version conflict", retryable: false } });
    }
    const next: Channel = {
      ...channel,
      name: req.name ?? channel.name,
      topic: req.topic === undefined ? channel.topic : req.topic,
      archived: req.archived ?? channel.archived,
      version: channel.version + 1,
      updatedAt: now(),
    };
    this.channels.set(id, next);
    return this.settle(next);
  }

  async addMember(id: common.ChannelId, userId: common.UserId, role: ChannelMember["role"] = "member"): Promise<ChannelMember> {
    const member: ChannelMember = { channelId: id, userId, role, joinedAt: now() };
    this.members.push(member);
    const channel = this.channels.get(id);
    if (channel) this.channels.set(id, { ...channel, memberCount: channel.memberCount + 1 });
    return this.settle(member);
  }

  async removeMember(id: common.ChannelId, userId: common.UserId): Promise<void> {
    this.members = this.members.filter((m) => !(m.channelId === id && m.userId === userId));
    const channel = this.channels.get(id);
    if (channel) this.channels.set(id, { ...channel, memberCount: Math.max(0, channel.memberCount - 1) });
    return this.settle(undefined);
  }

  async listMembers(id: common.ChannelId): Promise<ChannelMember[]> {
    const recorded = this.members.filter((m) => m.channelId === id);
    const channel = this.channels.get(id);
    // Synthesize a populated roster for the demo: topic/event channels include the
    // whole workspace (caller = admin); DMs keep just the recorded members. This
    // keeps the members popover realistic without bloating the seed.
    if (channel && channel.type !== "dm") {
      const byUser = new Map(recorded.map((m) => [m.userId, m]));
      for (const u of this.users.keys()) {
        if (!byUser.has(u)) {
          byUser.set(u, { channelId: id, userId: u, role: u === this.me ? "admin" : "member", joinedAt: now() });
        }
      }
      return this.settle([...byUser.values()]);
    }
    return this.settle(recorded);
  }

  async searchMessages(req: SearchMessagesRequest): Promise<SearchHit[]> {
    const q = req.q.trim().toLowerCase();
    if (q.length === 0) return this.settle([]);
    const limit = req.limit ?? 50;
    const hits: SearchHit[] = [];
    // newest first
    for (let i = this.messages.length - 1; i >= 0 && hits.length < limit; i--) {
      const m = this.messages[i]!;
      if (m.deletedAt) continue;
      if (req.channelId && m.channelId !== req.channelId) continue;
      if (!m.body.toLowerCase().includes(q)) continue;
      const ch = this.channels.get(m.channelId);
      if (!ch) continue;
      hits.push({ message: m, channelId: ch.id, channelName: ch.name, channelType: ch.type });
    }
    return this.settle(hits);
  }

  async listPinned(id: common.ChannelId): Promise<Message[]> {
    const set = this.pins.get(id);
    if (!set) return this.settle([]);
    const out = this.messages.filter((m) => set.has(m.id) && !m.deletedAt).sort((a, b) => (a.id < b.id ? 1 : -1));
    return this.settle(out);
  }

  async togglePin(id: common.ChannelId, messageId: common.MessageId): Promise<Message[]> {
    const set = this.pins.get(id) ?? new Set<common.MessageId>();
    if (set.has(messageId)) set.delete(messageId);
    else set.add(messageId);
    this.pins.set(id, set);
    return this.listPinned(id);
  }

  async listMessages(req: ListMessagesRequest): Promise<ListMessagesResponse> {
    const inChannel = this.messages.filter(
      (m) => m.channelId === req.channelId && (req.threadRootId ? m.threadRootId === req.threadRootId : m.threadRootId === null),
    );
    const limit = req.limit ?? 50;
    if (req.afterMessageId) {
      // ULID-ascending gap-fill (design §8-2 A)
      const after = inChannel.filter((m) => m.id > req.afterMessageId!);
      const page = after.slice(0, limit);
      const last = page[page.length - 1];
      const nextCursor = after.length > page.length && last ? `after:${last.id}` : null;
      return this.settle({ items: page, nextCursor });
    }
    // descending history page; cursor = "before:<id>"
    const before = req.cursor?.startsWith("before:") ? req.cursor.slice("before:".length) : null;
    const older = before ? inChannel.filter((m) => m.id < before) : inChannel;
    const tail = older.slice(Math.max(0, older.length - limit));
    const nextCursor = older.length > tail.length && tail[0] ? `before:${tail[0].id}` : null;
    return this.settle({ items: tail, nextCursor });
  }

  async postMessage(req: PostMessageRequest): Promise<PostMessageResponse> {
    const channel = this.channels.get(req.channelId);
    if (channel?.archived) {
      throw new ChatApiError(409, { error: { code: "CHAT_ARCHIVED_CHANNEL", message: "channel archived", retryable: false } });
    }
    if (req.body.trim().length === 0 && (req.attachments?.length ?? 0) === 0) {
      throw new ChatApiError(400, { error: { code: "VALIDATION_FAILED", message: "empty body", retryable: false } });
    }
    // consume latency + any primed error BEFORE mutating in-memory state
    await this.settle(undefined);
    const message: Message = {
      id: newMessageId(),
      channelId: req.channelId,
      authorId: this.me,
      body: req.body,
      threadRootId: req.threadRootId ?? null,
      replyCount: 0,
      reactions: [],
      attachments: req.attachments ?? [],
      editedAt: null,
      deletedAt: null,
      version: 1,
      createdAt: now(),
    };
    this.messages.push(message);
    if (req.threadRootId) {
      const rootIdx = this.messages.findIndex((m) => m.id === req.threadRootId);
      if (rootIdx >= 0) {
        const root = this.messages[rootIdx]!;
        this.messages[rootIdx] = { ...root, replyCount: root.replyCount + 1 };
      }
    }
    return { message, clientTempId: req.clientTempId };
  }

  async editMessage(id: common.MessageId, req: EditMessageRequest): Promise<Message> {
    const idx = this.messages.findIndex((m) => m.id === id);
    if (idx < 0) throw new ChatApiError(404, { error: { code: "NOT_FOUND", message: "message not found", retryable: false } });
    const msg = this.messages[idx]!;
    if (msg.version !== req.version) {
      throw new ChatApiError(409, { error: { code: "CHAT_VERSION_CONFLICT", message: "version conflict", retryable: false } });
    }
    const next: Message = { ...msg, body: req.body, editedAt: now(), version: msg.version + 1 };
    this.messages[idx] = next;
    return this.settle(next);
  }

  async deleteMessage(id: common.MessageId): Promise<Message> {
    const idx = this.messages.findIndex((m) => m.id === id);
    if (idx < 0) throw new ChatApiError(404, { error: { code: "NOT_FOUND", message: "message not found", retryable: false } });
    const msg = this.messages[idx]!;
    const next: Message = { ...msg, deletedAt: now(), body: "", attachments: [], version: msg.version + 1 };
    this.messages[idx] = next;
    return this.settle(next);
  }

  async toggleReaction(id: common.MessageId, req: ReactionToggleRequest): Promise<Message> {
    const idx = this.messages.findIndex((m) => m.id === id);
    if (idx < 0) throw new ChatApiError(404, { error: { code: "NOT_FOUND", message: "message not found", retryable: false } });
    this.messages = toggleReactionLocal(this.messages, id, req.emoji, this.me);
    const updated = this.messages.find((m) => m.id === id)!;
    return this.settle(updated);
  }

  async updateReadState(req: ReadStateUpdateRequest): Promise<void> {
    this.readState.set(req.channelId, req.lastReadMessageId);
    return this.settle(undefined);
  }

  async listUnread(): Promise<UnreadSummary[]> {
    const out: UnreadSummary[] = [];
    for (const channelId of this.channels.keys()) {
      const lastRead = this.readState.get(channelId) ?? null;
      const unread = this.messages.filter(
        (m) => m.channelId === channelId && m.authorId !== this.me && (lastRead === null || m.id > lastRead),
      );
      out.push({
        channelId,
        unreadCount: unread.length,
        lastReadMessageId: lastRead,
        mentioned: unread.some((m) => m.body.includes(`<@${this.me}>`)),
      });
    }
    return this.settle(out);
  }

  async getWsTicket(id: common.ChannelId): Promise<WsTicketResponse> {
    return this.settle({
      ticket: `mock-ticket-${id}`,
      doUrl: `wss://chat-rt.developershub.jp/ws/${id}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  }

  async resolveUsers(ids: common.UserId[]): Promise<identity.UserSummary[]> {
    const out: identity.UserSummary[] = [];
    for (const id of ids.slice(0, 50)) {
      const u = this.users.get(id);
      out.push(u ?? { id, displayName: id, avatarUrl: null });
    }
    return this.settle(out);
  }
}
