// In-memory ChatRepo: backs unit tests and local runs. Mirrors the D1 repo's
// keyset (by ULID id) so pagination / gap-fill tests are representative.
import type { common } from "@dub/types";
import type { ChatRepo, ChannelRow, MemberRow, MessageRow, SearchRow, MessageDeletionPolicy, DeletionPolicyRow } from "./types";

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface ReactionKey {
  emoji: string;
  userId: common.UserId;
  at: string;
}

export class InMemoryChatRepo implements ChatRepo {
  private channels = new Map<common.ChannelId, ChannelRow>();
  private members = new Map<string, MemberRow>(); // key: channelId|userId
  private messages = new Map<common.MessageId, MessageRow>();
  private reactions = new Map<common.MessageId, ReactionKey[]>();
  private reads = new Map<string, { lastReadMessageId: common.MessageId | null }>(); // channelId|userId
  private pins = new Map<common.ChannelId, Map<common.MessageId, string>>(); // channelId -> (messageId -> pinnedAt)
  private settings = new Map<common.OrgId, DeletionPolicyRow>(); // orgId -> policy + version

  private mkey(channelId: string, userId: string): string {
    return `${channelId}|${userId}`;
  }

  // ---- test/seed helpers (bypass service invariants) ----
  seedChannel(row: ChannelRow): void {
    this.channels.set(row.id, { ...row });
  }
  seedMember(row: MemberRow): void {
    this.members.set(this.mkey(row.channelId, row.userId), { ...row });
  }

  // ---- channels ----
  async createChannel(row: ChannelRow): Promise<void> {
    if (row.dmKey) {
      for (const c of this.channels.values()) if (c.dmKey === row.dmKey) {
        throw new Error("dm_key UNIQUE violation");
      }
    }
    this.channels.set(row.id, { ...row });
  }
  async getChannel(id: common.ChannelId): Promise<ChannelRow | null> {
    const r = this.channels.get(id);
    return r ? { ...r } : null;
  }
  async getChannelByDmKey(dmKey: string): Promise<ChannelRow | null> {
    for (const c of this.channels.values()) if (c.dmKey === dmKey) return { ...c };
    return null;
  }
  async listChannelsForUser(q: {
    userId: common.UserId;
    eventId?: common.EventId;
    includeArchived: boolean;
    limit: number;
    afterId?: string;
  }): Promise<ChannelRow[]> {
    let rows = [...this.channels.values()].filter((c) => {
      const isMember = this.members.has(this.mkey(c.id, q.userId));
      const visible = c.visibility === "public" || isMember;
      if (!visible) return false;
      if (!q.includeArchived && c.archivedAt !== null) return false;
      if (q.eventId && c.eventId !== q.eventId) return false;
      return true;
    });
    rows.sort((a, b) => cmpStr(a.id, b.id));
    if (q.afterId) rows = rows.filter((c) => c.id > q.afterId!);
    return rows.slice(0, q.limit).map((c) => ({ ...c }));
  }
  async updateChannel(next: ChannelRow, expectedVersion: number): Promise<boolean> {
    const cur = this.channels.get(next.id);
    if (!cur || cur.version !== expectedVersion) return false;
    this.channels.set(next.id, { ...next });
    return true;
  }

  // ---- members ----
  async addMember(row: MemberRow): Promise<void> {
    this.members.set(this.mkey(row.channelId, row.userId), { ...row });
  }
  async removeMember(channelId: common.ChannelId, userId: common.UserId): Promise<boolean> {
    return this.members.delete(this.mkey(channelId, userId));
  }
  async getMember(channelId: common.ChannelId, userId: common.UserId): Promise<MemberRow | null> {
    const r = this.members.get(this.mkey(channelId, userId));
    return r ? { ...r } : null;
  }
  async listMembers(channelId: common.ChannelId): Promise<MemberRow[]> {
    return [...this.members.values()].filter((m) => m.channelId === channelId).map((m) => ({ ...m }));
  }
  async membershipsForUser(userId: common.UserId): Promise<MemberRow[]> {
    return [...this.members.values()].filter((m) => m.userId === userId).map((m) => ({ ...m }));
  }

  // ---- messages ----
  async createMessage(row: MessageRow): Promise<void> {
    this.messages.set(row.id, { ...row, attachmentFileIds: [...row.attachmentFileIds] });
  }
  async getMessage(id: common.MessageId): Promise<MessageRow | null> {
    const r = this.messages.get(id);
    return r ? { ...r, attachmentFileIds: [...r.attachmentFileIds] } : null;
  }
  async listMessages(q: {
    channelId: common.ChannelId;
    threadRootId?: common.MessageId;
    afterMessageId?: common.MessageId;
    beforeId?: string;
    limit: number;
  }): Promise<MessageRow[]> {
    let rows = [...this.messages.values()].filter((m) => m.channelId === q.channelId);
    if (q.threadRootId !== undefined) rows = rows.filter((m) => m.threadRootId === q.threadRootId);
    else rows = rows.filter((m) => m.threadRootId === null); // main timeline = top-level only
    if (q.afterMessageId !== undefined) {
      // asc gap-fill: id > afterMessageId
      rows = rows.filter((m) => m.id > q.afterMessageId!).sort((a, b) => cmpStr(a.id, b.id));
    } else {
      // desc history; cursor: id < beforeId
      if (q.beforeId !== undefined) rows = rows.filter((m) => m.id < q.beforeId!);
      rows.sort((a, b) => cmpStr(b.id, a.id));
    }
    return rows.slice(0, q.limit).map((m) => ({ ...m, attachmentFileIds: [...m.attachmentFileIds] }));
  }
  async replyCounts(rootIds: common.MessageId[]): Promise<Map<string, number>> {
    const want = new Set(rootIds);
    const out = new Map<string, number>();
    for (const m of this.messages.values()) {
      if (m.threadRootId && want.has(m.threadRootId) && m.deletedAt === null) {
        out.set(m.threadRootId, (out.get(m.threadRootId) ?? 0) + 1);
      }
    }
    return out;
  }
  async updateMessage(next: MessageRow, expectedVersion: number): Promise<boolean> {
    const cur = this.messages.get(next.id);
    if (!cur || cur.version !== expectedVersion) return false;
    this.messages.set(next.id, { ...next, attachmentFileIds: [...next.attachmentFileIds] });
    return true;
  }

  // ---- reactions ----
  async hasReaction(messageId: common.MessageId, emoji: string, userId: common.UserId): Promise<boolean> {
    return (this.reactions.get(messageId) ?? []).some((r) => r.emoji === emoji && r.userId === userId);
  }
  async addReaction(messageId: common.MessageId, emoji: string, userId: common.UserId, at: string): Promise<void> {
    const list = this.reactions.get(messageId) ?? [];
    if (!list.some((r) => r.emoji === emoji && r.userId === userId)) list.push({ emoji, userId, at });
    this.reactions.set(messageId, list);
  }
  async removeReaction(messageId: common.MessageId, emoji: string, userId: common.UserId): Promise<boolean> {
    const list = this.reactions.get(messageId) ?? [];
    const next = list.filter((r) => !(r.emoji === emoji && r.userId === userId));
    this.reactions.set(messageId, next);
    return next.length !== list.length;
  }
  async reactionsFor(messageIds: common.MessageId[]): Promise<Map<string, Record<string, common.UserId[]>>> {
    const out = new Map<string, Record<string, common.UserId[]>>();
    for (const id of messageIds) {
      const list = this.reactions.get(id) ?? [];
      if (list.length === 0) continue;
      const map: Record<string, common.UserId[]> = {};
      for (const r of [...list].sort((a, b) => cmpStr(a.at + a.userId, b.at + b.userId))) {
        (map[r.emoji] ??= []).push(r.userId);
      }
      out.set(id, map);
    }
    return out;
  }

  // ---- read states ----
  async setReadState(channelId: common.ChannelId, userId: common.UserId, lastReadMessageId: common.MessageId, _at: string): Promise<void> {
    this.reads.set(this.mkey(channelId, userId), { lastReadMessageId });
  }
  async getReadState(channelId: common.ChannelId, userId: common.UserId): Promise<{ lastReadMessageId: common.MessageId | null } | null> {
    const r = this.reads.get(this.mkey(channelId, userId));
    return r ? { ...r } : null;
  }
  async countUnread(channelId: common.ChannelId, userId: common.UserId, lastReadMessageId: common.MessageId | null): Promise<number> {
    let n = 0;
    for (const m of this.messages.values()) {
      if (m.channelId !== channelId) continue;
      if (m.deletedAt !== null) continue;
      if (m.authorId === userId) continue; // own messages are not unread
      if (lastReadMessageId === null || m.id > lastReadMessageId) n++;
    }
    return n;
  }

  // ---- pins ----
  async listPinnedMessages(channelId: common.ChannelId): Promise<MessageRow[]> {
    const set = this.pins.get(channelId);
    if (!set) return [];
    return [...this.messages.values()]
      .filter((m) => m.channelId === channelId && m.deletedAt === null && set.has(m.id))
      .sort((a, b) => cmpStr(b.id, a.id)) // newest-pinned message first (id desc)
      .map((m) => ({ ...m, attachmentFileIds: [...m.attachmentFileIds] }));
  }
  async isPinned(channelId: common.ChannelId, messageId: common.MessageId): Promise<boolean> {
    return this.pins.get(channelId)?.has(messageId) ?? false;
  }
  async addPin(channelId: common.ChannelId, messageId: common.MessageId, _userId: common.UserId, at: string): Promise<void> {
    const set = this.pins.get(channelId) ?? new Map<common.MessageId, string>();
    if (!set.has(messageId)) set.set(messageId, at);
    this.pins.set(channelId, set);
  }
  async removePin(channelId: common.ChannelId, messageId: common.MessageId): Promise<boolean> {
    return this.pins.get(channelId)?.delete(messageId) ?? false;
  }

  // ---- search ----
  async searchMessages(q: { userId: common.UserId; text: string; channelId?: common.ChannelId; limit: number }): Promise<SearchRow[]> {
    const needle = q.text.toLowerCase();
    const out: SearchRow[] = [];
    const rows = [...this.messages.values()].sort((a, b) => cmpStr(b.id, a.id)); // newest first
    for (const m of rows) {
      if (out.length >= q.limit) break;
      if (m.deletedAt !== null) continue;
      if (q.channelId && m.channelId !== q.channelId) continue;
      if (!m.body.toLowerCase().includes(needle)) continue;
      const ch = this.channels.get(m.channelId);
      if (!ch) continue;
      const readable = ch.visibility === "public" || this.members.has(this.mkey(ch.id, q.userId));
      if (!readable) continue;
      out.push({ message: { ...m, attachmentFileIds: [...m.attachmentFileIds] }, channelName: ch.name, channelType: ch.type });
    }
    return out;
  }

  // ---- deletion policy ----
  async getDeletionPolicy(orgId: common.OrgId): Promise<DeletionPolicyRow | null> {
    const r = this.settings.get(orgId);
    return r ? { policy: { ...r.policy }, version: r.version } : null;
  }
  async setDeletionPolicy(input: {
    orgId: common.OrgId;
    policy: MessageDeletionPolicy;
    expectedVersion: number;
    updatedBy: common.UserId | null;
    at: common.ISODateTime;
  }): Promise<{ version: number } | null> {
    const cur = this.settings.get(input.orgId);
    const curVersion = cur?.version ?? 0;
    if (input.expectedVersion !== curVersion) return null; // optimistic-concurrency conflict
    const version = curVersion + 1;
    this.settings.set(input.orgId, { policy: { ...input.policy }, version });
    return { version };
  }

  // ---- hard delete (physical removal + cascade) ----
  async hardDeleteMessage(id: common.MessageId): Promise<void> {
    const replyIds = [...this.messages.values()].filter((m) => m.threadRootId === id).map((m) => m.id);
    for (const rid of [id, ...replyIds]) {
      this.messages.delete(rid);
      this.reactions.delete(rid);
      for (const set of this.pins.values()) set.delete(rid);
    }
  }
}
