// Business logic for chat (channels / members / messages / reactions / read /
// ws-ticket / system posts). Pure of HTTP: parsed inputs + a request context in,
// DubError thrown, wire DTOs out. The Hono app is a thin adapter over this.
//
// Ordering rule (design §4): domain events are published AFTER the DB write
// (post-commit) so a failed write never emits. Audit for delete/archive uses
// Queue publishAudit (design §4 / theme13).
import { DubError, CommonErrorCodes, errors } from "@dub/errors";
import type { common, auditLog } from "@dub/types";
import type {
  AppDeps,
  Channel,
  ChannelRow,
  CreateChannelRequest,
  UpdateChannelRequest,
  AddMemberRequest,
  GetChannelResponse,
  GetPresenceResponse,
  ListChannelsResponse,
  ListMessagesResponse,
  ListPinsResponse,
  MarkUnreadRequest,
  Message,
  MessageRow,
  MemberRow,
  PinMessageRequest,
  PinnedItem,
  PostMessageRequest,
  PostSystemMessageRequest,
  PresenceRow,
  PresenceView,
  ReactionToggleResponse,
  ReadStateUpdateRequest,
  SearchMessagesResponse,
  SetPresenceRequest,
  UnreadResponse,
  UnreadSummary,
  WsTicketResponse,
} from "./types";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_BODY_LEN,
  buildDoUrl,
  decodeCursor,
  derivePresence,
  dmKey as deriveDmKey,
  encodeCursor,
  toChannel,
  toMember,
  toMessage,
} from "./domain";
import { signWsTicket, ticketExpiryMs } from "./wsticket";

export interface ReqCtx {
  requestId: string;
  userId: common.UserId;
}

const errArchived = (id: string): DubError =>
  new DubError("CHAT_CHANNEL_ARCHIVED", `Channel is archived: ${id}`, { status: 409 });
const errVersionConflict = (id: string): DubError =>
  new DubError("CHAT_VERSION_CONFLICT", `Version conflict for ${id}`, { status: 409 });

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw errors.validationFailed([{ field, reason: "required" }]);
  }
  return value;
}
function requireBody(value: unknown): string {
  const s = nonEmptyString(value, "body");
  if (s.length > MAX_BODY_LEN) throw errors.validationFailed([{ field: "body", reason: "too_long" }]);
  return s;
}
function requireLimit(raw?: number): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(raw) || raw < 1 || raw > MAX_LIMIT) {
    throw errors.validationFailed([{ field: "limit", reason: raw > MAX_LIMIT ? "too_large" : "invalid" }]);
  }
  return raw;
}

export class ChatService {
  constructor(private readonly deps: AppDeps) {}

  private actor(ctx: ReqCtx): { requestId: string; actorId: string | null } {
    return { requestId: ctx.requestId, actorId: ctx.userId };
  }

  private async audit(
    ctx: { requestId: string; userId: common.UserId | null },
    action: string,
    resourceType: string,
    resourceId: string,
    details: Record<string, unknown> | null,
    result: auditLog.AuditResult = "success",
  ): Promise<void> {
    await this.deps.audit.record({
      action,
      actorId: ctx.userId,
      orgId: this.deps.orgId,
      result,
      resourceType,
      resourceId,
      details,
      requestId: ctx.requestId,
      occurredAt: this.deps.now(),
    });
  }

  // Load a channel for READ. Missing -> 404. Private + non-member -> 404 (hide).
  private async loadReadable(id: common.ChannelId, userId: common.UserId): Promise<{ channel: ChannelRow; membership: MemberRow | null }> {
    const channel = await this.deps.repo.getChannel(id);
    if (!channel) throw errors.notFound("channel", id);
    const membership = await this.deps.repo.getMember(id, userId);
    if (channel.visibility === "private" && !membership) throw errors.notFound("channel", id);
    return { channel, membership };
  }

  // Require WRITE membership (post / react / read / ws). Non-member -> 403.
  private async requireMember(channel: ChannelRow, userId: common.UserId): Promise<MemberRow> {
    const m = await this.deps.repo.getMember(channel.id, userId);
    if (!m) throw new DubError(CommonErrorCodes.FORBIDDEN, "not a channel member", { status: 403 });
    return m;
  }

  private async isChannelAdmin(ctx: ReqCtx, channel: ChannelRow, membership?: MemberRow | null): Promise<boolean> {
    const m = membership ?? (await this.deps.repo.getMember(channel.id, ctx.userId));
    if (m?.role === "admin") return true;
    return this.deps.authz.hasPermission(ctx.userId, this.deps.orgId, { permission: "chat:moderate" });
  }

  // ---- channels ----
  async createChannel(ctx: ReqCtx, body: CreateChannelRequest): Promise<Channel> {
    const type = body.type;
    if (type !== "event" && type !== "topic" && type !== "dm") {
      throw errors.validationFailed([{ field: "type", reason: "invalid" }]);
    }
    const visibility = body.visibility === "public" ? "public" : body.visibility === "private" ? "private" : null;
    if (!visibility) throw errors.validationFailed([{ field: "visibility", reason: "invalid" }]);
    const name = nonEmptyString(body.name, "name");

    let eventId: common.EventId | null = null;
    if (type === "event") {
      if (!body.eventId) throw errors.validationFailed([{ field: "eventId", reason: "required" }]);
      const exists = await this.deps.eventClient.eventExists({ requestId: ctx.requestId, userId: ctx.userId }, body.eventId);
      if (!exists) throw errors.notFound("event", body.eventId);
      eventId = body.eventId;
    }

    const initialMembers = [...new Set([ctx.userId, ...(body.memberIds ?? [])])];

    // DM dedup: same participant set returns the existing channel (idempotent).
    let dmKey: string | null = null;
    if (type === "dm") {
      dmKey = deriveDmKey(initialMembers);
      const existing = await this.deps.repo.getChannelByDmKey(dmKey);
      if (existing) return toChannel(existing);
    }

    const now = this.deps.now();
    const row: ChannelRow = {
      id: this.deps.newChannelId(),
      type,
      visibility,
      name,
      topic: body.topic ?? null,
      eventId,
      dmKey,
      createdBy: ctx.userId,
      archivedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.repo.createChannel(row);
    for (const uid of initialMembers) {
      await this.deps.repo.addMember({
        channelId: row.id,
        userId: uid,
        role: uid === ctx.userId ? "admin" : "member",
        joinedAt: now,
      });
    }

    await this.deps.publisher.publish("chat.channel.created", { channelId: row.id, name: row.name }, this.actor(ctx));
    for (const uid of initialMembers) {
      if (uid === ctx.userId) continue;
      await this.deps.publisher.publish("chat.member.added", { channelId: row.id, userId: uid, change: "added" }, this.actor(ctx));
      await this.deps.realtime.publishToChannel(row.id, { kind: "member.added", channelId: row.id, userId: uid, at: now });
    }
    await this.audit(ctx, "chat.channel.created", "channel", row.id, { type, visibility });
    return toChannel(row);
  }

  async getChannel(ctx: ReqCtx, id: common.ChannelId): Promise<GetChannelResponse> {
    const { channel, membership } = await this.loadReadable(id, ctx.userId);
    return { channel: toChannel(channel), membership: membership ? toMember(membership) : null };
  }

  async listChannels(ctx: ReqCtx, q: { cursor?: string; limit?: number; eventId?: common.EventId }): Promise<ListChannelsResponse> {
    const limit = requireLimit(q.limit);
    const afterId = q.cursor ? decodeCursor(q.cursor) ?? invalidCursor(q.cursor) : undefined;
    const rows = await this.deps.repo.listChannelsForUser({
      userId: ctx.userId,
      ...(q.eventId ? { eventId: q.eventId } : {}),
      includeArchived: false,
      limit: limit + 1,
      ...(afterId ? { afterId } : {}),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return { items: page.map(toChannel), nextCursor: hasMore && last ? encodeCursor(last.id) : null };
  }

  async updateChannel(ctx: ReqCtx, id: common.ChannelId, body: UpdateChannelRequest): Promise<Channel> {
    if (typeof body.version !== "number") throw errors.validationFailed([{ field: "version", reason: "required" }]);
    const { channel, membership } = await this.loadReadable(id, ctx.userId);
    if (!(await this.isChannelAdmin(ctx, channel, membership))) {
      throw new DubError(CommonErrorCodes.FORBIDDEN, "channel admin required", { status: 403 });
    }
    if (channel.version !== body.version) throw errVersionConflict(id);

    const next: ChannelRow = { ...channel };
    const changed: string[] = [];
    if (body.name !== undefined) {
      next.name = nonEmptyString(body.name, "name");
      changed.push("name");
    }
    if (body.topic !== undefined) {
      next.topic = body.topic;
      changed.push("topic");
    }
    let archivedNow = false;
    if (body.archived !== undefined) {
      if (body.archived && !channel.archivedAt) {
        next.archivedAt = this.deps.now();
        archivedNow = true;
        changed.push("archived");
      } else if (!body.archived && channel.archivedAt) {
        next.archivedAt = null;
        changed.push("archived");
      }
    }
    if (changed.length === 0) return toChannel(channel);

    next.version = channel.version + 1;
    next.updatedAt = this.deps.now();
    if (!(await this.deps.repo.updateChannel(next, body.version))) throw errVersionConflict(id);

    if (archivedNow) await this.audit(ctx, "chat.channel.archive", "channel", id, null);
    return toChannel(next);
  }

  async addMember(ctx: ReqCtx, id: common.ChannelId, body: AddMemberRequest): Promise<void> {
    const userId = nonEmptyString(body.userId, "userId");
    const channel = await this.deps.repo.getChannel(id);
    if (!channel) throw errors.notFound("channel", id);
    if (!(await this.isChannelAdmin(ctx, channel))) {
      throw new DubError(CommonErrorCodes.FORBIDDEN, "channel admin required", { status: 403 });
    }
    if (channel.archivedAt) throw errArchived(id);
    const existing = await this.deps.repo.getMember(id, userId);
    if (existing) return; // idempotent
    const now = this.deps.now();
    await this.deps.repo.addMember({ channelId: id, userId, role: body.role === "admin" ? "admin" : "member", joinedAt: now });
    await this.deps.publisher.publish("chat.member.added", { channelId: id, userId, change: "added" }, this.actor(ctx));
    await this.deps.realtime.publishToChannel(id, { kind: "member.added", channelId: id, userId, at: now });
    await this.audit(ctx, "chat.member.add", "channel", id, { userId });
  }

  async removeMember(ctx: ReqCtx, id: common.ChannelId, userId: common.UserId): Promise<void> {
    const channel = await this.deps.repo.getChannel(id);
    if (!channel) throw errors.notFound("channel", id);
    const isSelf = userId === ctx.userId;
    if (!isSelf && !(await this.isChannelAdmin(ctx, channel))) {
      throw new DubError(CommonErrorCodes.FORBIDDEN, "channel admin or self required", { status: 403 });
    }
    const removed = await this.deps.repo.removeMember(id, userId);
    if (!removed) return; // idempotent
    const now = this.deps.now();
    await this.deps.publisher.publish("chat.member.removed", { channelId: id, userId, change: "removed" }, this.actor(ctx));
    await this.deps.realtime.publishToChannel(id, { kind: "member.removed", channelId: id, userId, at: now });
    await this.audit(ctx, "chat.member.remove", "channel", id, { userId, self: isSelf });
  }

  // Enrich a page of rows with reactions + thread reply counts (batched). Only
  // top-level rows (threadRootId null) can carry replies; replies stay at 0.
  private async enrichMessages(rows: MessageRow[]): Promise<Message[]> {
    if (rows.length === 0) return [];
    const reactions = await this.deps.repo.reactionsFor(rows.map((r) => r.id));
    const rootIds = rows.filter((r) => r.threadRootId === null).map((r) => r.id);
    const replies = await this.deps.repo.replyCountsFor(rootIds);
    return rows.map((r) => toMessage(r, reactions.get(r.id) ?? {}, replies.get(r.id) ?? 0));
  }

  private async enrichOne(row: MessageRow): Promise<Message> {
    const [msg] = await this.enrichMessages([row]);
    return msg!;
  }

  // ---- messages ----
  async postMessage(ctx: ReqCtx, body: PostMessageRequest): Promise<Message> {
    const text = requireBody(body.body);
    const { channel } = await this.loadReadable(body.channelId, ctx.userId);
    await this.requireMember(channel, ctx.userId);
    if (channel.archivedAt) throw errArchived(channel.id);

    if (body.threadRootId !== undefined) {
      const root = await this.deps.repo.getMessage(body.threadRootId);
      if (!root || root.channelId !== channel.id) {
        throw errors.validationFailed([{ field: "threadRootId", reason: "not_in_channel" }]);
      }
    }

    const now = this.deps.now();
    const row: MessageRow = {
      id: this.deps.newMessageId(),
      channelId: channel.id,
      threadRootId: body.threadRootId ?? null,
      authorId: ctx.userId,
      kind: "user",
      body: text,
      attachmentFileIds: body.attachmentFileIds ?? [],
      version: 1,
      editedAt: null,
      deletedAt: null,
      createdAt: now,
    };
    await this.deps.repo.createMessage(row);
    if (row.attachmentFileIds.length > 0) {
      await this.deps.fileClient.registerLinks({ requestId: ctx.requestId, userId: ctx.userId }, row.id, row.attachmentFileIds);
    }

    // post-commit fan-out
    await this.deps.publisher.publish(
      "chat.message.created",
      { channelId: channel.id, messageId: row.id, authorId: ctx.userId },
      this.actor(ctx),
    );
    await this.deps.realtime.publishToChannel(channel.id, {
      kind: "message.created",
      channelId: channel.id,
      messageId: row.id,
      authorId: ctx.userId,
      body: text,
      at: now,
    });
    return toMessage(row, {});
  }

  async listMessages(
    ctx: ReqCtx,
    q: { channelId: common.ChannelId; cursor?: string; limit?: number; threadRootId?: common.MessageId; afterMessageId?: common.MessageId },
  ): Promise<ListMessagesResponse> {
    if (q.cursor !== undefined && q.afterMessageId !== undefined) {
      throw errors.validationFailed([{ field: "cursor", reason: "exclusive_with_afterMessageId" }]);
    }
    const { channel } = await this.loadReadable(q.channelId, ctx.userId);
    await this.requireMember(channel, ctx.userId);
    const limit = requireLimit(q.limit);

    if (q.afterMessageId !== undefined) {
      // asc gap-fill; bounded catch-up (client advances afterMessageId itself).
      const rows = await this.deps.repo.listMessages({
        channelId: channel.id,
        ...(q.threadRootId ? { threadRootId: q.threadRootId } : {}),
        afterMessageId: q.afterMessageId,
        limit,
      });
      return { items: await this.enrichMessages(rows), nextCursor: null };
    }

    const beforeId = q.cursor ? decodeCursor(q.cursor) ?? invalidCursor(q.cursor) : undefined;
    const rows = await this.deps.repo.listMessages({
      channelId: channel.id,
      ...(q.threadRootId ? { threadRootId: q.threadRootId } : {}),
      ...(beforeId ? { beforeId } : {}),
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      items: await this.enrichMessages(page),
      nextCursor: hasMore && last ? encodeCursor(last.id) : null,
    };
  }

  async editMessage(ctx: ReqCtx, id: common.MessageId, body: { version?: number; body?: string }): Promise<Message> {
    if (typeof body.version !== "number") throw errors.validationFailed([{ field: "version", reason: "required" }]);
    const msg = await this.deps.repo.getMessage(id);
    if (!msg || msg.deletedAt) throw errors.notFound("message", id);
    if (msg.authorId !== ctx.userId) throw new DubError(CommonErrorCodes.FORBIDDEN, "only the author can edit", { status: 403 });
    const channel = await this.deps.repo.getChannel(msg.channelId);
    if (channel?.archivedAt) throw errArchived(channel.id);
    if (msg.version !== body.version) throw errVersionConflict(id);

    const text = requireBody(body.body);
    const now = this.deps.now();
    const next: MessageRow = { ...msg, body: text, editedAt: now, version: msg.version + 1 };
    if (!(await this.deps.repo.updateMessage(next, body.version))) throw errVersionConflict(id);
    // No chat.message.updated in the frozen catalog and no RT variant -> audit only.
    await this.audit(ctx, "chat.message.update", "message", id, null);
    return this.enrichOne(next);
  }

  async deleteMessage(ctx: ReqCtx, id: common.MessageId): Promise<void> {
    const msg = await this.deps.repo.getMessage(id);
    if (!msg) throw errors.notFound("message", id);
    const channel = await this.deps.repo.getChannel(msg.channelId);
    if (!channel) throw errors.notFound("message", id);
    const isAuthor = msg.authorId === ctx.userId;
    if (!isAuthor && !(await this.isChannelAdmin(ctx, channel))) {
      throw new DubError(CommonErrorCodes.FORBIDDEN, "author or channel admin required", { status: 403 });
    }
    if (msg.deletedAt) return; // idempotent
    const now = this.deps.now();
    const next: MessageRow = { ...msg, deletedAt: now, version: msg.version + 1 };
    if (!(await this.deps.repo.updateMessage(next, msg.version))) throw errVersionConflict(id);

    await this.deps.publisher.publish("chat.message.deleted", { channelId: channel.id, messageId: id }, this.actor(ctx));
    await this.deps.realtime.publishToChannel(channel.id, { kind: "message.deleted", channelId: channel.id, messageId: id, at: now });
    await this.audit(ctx, "chat.message.delete", "message", id, { channelId: channel.id, byAuthor: isAuthor });
  }

  async toggleReaction(ctx: ReqCtx, id: common.MessageId, emoji: string): Promise<ReactionToggleResponse> {
    const clean = nonEmptyString(emoji, "emoji");
    const msg = await this.deps.repo.getMessage(id);
    if (!msg || msg.deletedAt) throw errors.notFound("message", id);
    const { channel } = await this.loadReadable(msg.channelId, ctx.userId);
    await this.requireMember(channel, ctx.userId);

    const has = await this.deps.repo.hasReaction(id, clean, ctx.userId);
    if (has) await this.deps.repo.removeReaction(id, clean, ctx.userId);
    else await this.deps.repo.addReaction(id, clean, ctx.userId, this.deps.now());
    const reactions = await this.deps.repo.reactionsFor([id]);
    return { messageId: id, reactions: reactions.get(id) ?? {} };
  }

  // ---- read state / unread ----
  async updateReadState(ctx: ReqCtx, id: common.ChannelId, body: ReadStateUpdateRequest): Promise<UnreadSummary> {
    const lastReadMessageId = nonEmptyString(body.lastReadMessageId, "lastReadMessageId");
    const { channel } = await this.loadReadable(id, ctx.userId);
    await this.requireMember(channel, ctx.userId);
    await this.deps.repo.setReadState(id, ctx.userId, lastReadMessageId, this.deps.now());
    const unreadCount = await this.deps.repo.countUnread(id, ctx.userId, lastReadMessageId);
    return { channelId: id, unreadCount, lastReadMessageId };
  }

  async unread(ctx: ReqCtx): Promise<UnreadResponse> {
    const memberships = await this.deps.repo.membershipsForUser(ctx.userId);
    const items: UnreadSummary[] = [];
    for (const m of memberships) {
      const rs = await this.deps.repo.getReadState(m.channelId, ctx.userId);
      const lastReadMessageId = rs?.lastReadMessageId ?? null;
      const unreadCount = await this.deps.repo.countUnread(m.channelId, ctx.userId, lastReadMessageId);
      items.push({ channelId: m.channelId, unreadCount, lastReadMessageId });
    }
    return { items };
  }

  // Mark a channel unread from a message (Slack "Mark as unread"): rewind the read
  // cursor to just before `messageId` so it becomes the first unread.
  async markUnread(ctx: ReqCtx, id: common.ChannelId, body: MarkUnreadRequest): Promise<UnreadSummary> {
    const messageId = nonEmptyString(body.messageId, "messageId");
    const { channel } = await this.loadReadable(id, ctx.userId);
    await this.requireMember(channel, ctx.userId);
    const msg = await this.deps.repo.getMessage(messageId);
    if (!msg || msg.channelId !== channel.id) {
      throw errors.validationFailed([{ field: "messageId", reason: "not_in_channel" }]);
    }
    const prev = await this.deps.repo.previousMessageId(channel.id, messageId);
    if (prev) await this.deps.repo.setReadState(channel.id, ctx.userId, prev, this.deps.now());
    else await this.deps.repo.clearReadState(channel.id, ctx.userId);
    const unreadCount = await this.deps.repo.countUnread(channel.id, ctx.userId, prev);
    return { channelId: channel.id, unreadCount, lastReadMessageId: prev };
  }

  // ---- join (self-join a public channel; Slack "Join channel") ----
  async joinChannel(ctx: ReqCtx, id: common.ChannelId): Promise<GetChannelResponse> {
    const channel = await this.deps.repo.getChannel(id);
    if (!channel) throw errors.notFound("channel", id);
    const existing = await this.deps.repo.getMember(id, ctx.userId);
    // Private channels are invite-only: non-members can't see or self-join (hide -> 404).
    if (channel.visibility === "private") {
      if (!existing) throw errors.notFound("channel", id);
      return { channel: toChannel(channel), membership: toMember(existing) };
    }
    if (existing) return { channel: toChannel(channel), membership: toMember(existing) }; // idempotent
    if (channel.archivedAt) throw errArchived(id);
    const now = this.deps.now();
    await this.deps.repo.addMember({ channelId: id, userId: ctx.userId, role: "member", joinedAt: now });
    await this.deps.publisher.publish("chat.member.added", { channelId: id, userId: ctx.userId, change: "added" }, this.actor(ctx));
    await this.deps.realtime.publishToChannel(id, { kind: "member.added", channelId: id, userId: ctx.userId, at: now });
    await this.audit(ctx, "chat.member.join", "channel", id, { self: true });
    const membership = await this.deps.repo.getMember(id, ctx.userId);
    return { channel: toChannel(channel), membership: membership ? toMember(membership) : null };
  }

  // ---- search (full-text over the caller's channels; Slack in:/from:) ----
  async searchMessages(
    ctx: ReqCtx,
    q: { q: string; in?: common.ChannelId; from?: common.UserId; cursor?: string; limit?: number },
  ): Promise<SearchMessagesResponse> {
    const text = nonEmptyString(q.q, "q");
    const limit = requireLimit(q.limit);
    const beforeId = q.cursor ? decodeCursor(q.cursor) ?? invalidCursor(q.cursor) : undefined;

    let channelIds: common.ChannelId[];
    if (q.in) {
      // `in:#channel` — the caller must be a member (private stays hidden via loadReadable).
      const { channel } = await this.loadReadable(q.in, ctx.userId);
      await this.requireMember(channel, ctx.userId);
      channelIds = [channel.id];
    } else {
      const memberships = await this.deps.repo.membershipsForUser(ctx.userId);
      channelIds = memberships.map((m) => m.channelId);
    }

    const rows = await this.deps.repo.searchMessages({
      channelIds,
      text,
      ...(q.from ? { fromUserId: q.from } : {}),
      ...(beforeId ? { beforeId } : {}),
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return { items: await this.enrichMessages(page), nextCursor: hasMore && last ? encodeCursor(last.id) : null };
  }

  // ---- pins (channel pinned items) ----
  async pinMessage(ctx: ReqCtx, channelId: common.ChannelId, body: PinMessageRequest): Promise<PinnedItem> {
    const messageId = nonEmptyString(body.messageId, "messageId");
    const { channel } = await this.loadReadable(channelId, ctx.userId);
    await this.requireMember(channel, ctx.userId);
    if (channel.archivedAt) throw errArchived(channel.id);
    const msg = await this.deps.repo.getMessage(messageId);
    if (!msg || msg.channelId !== channel.id || msg.deletedAt) throw errors.notFound("message", messageId);
    const now = this.deps.now();
    await this.deps.repo.addPin({ channelId: channel.id, messageId, pinnedBy: ctx.userId, pinnedAt: now });
    await this.audit(ctx, "chat.pin.add", "message", messageId, { channelId: channel.id });
    // Read back the stored pin so an already-pinned message returns its original pinner/time.
    const pin = (await this.deps.repo.listPins(channel.id)).find((p) => p.messageId === messageId)
      ?? { channelId: channel.id, messageId, pinnedBy: ctx.userId, pinnedAt: now };
    return { ...pin, message: await this.enrichOne(msg) };
  }

  async unpinMessage(ctx: ReqCtx, channelId: common.ChannelId, messageId: common.MessageId): Promise<void> {
    const { channel } = await this.loadReadable(channelId, ctx.userId);
    await this.requireMember(channel, ctx.userId);
    const removed = await this.deps.repo.removePin(channel.id, messageId);
    if (removed) await this.audit(ctx, "chat.pin.remove", "message", messageId, { channelId: channel.id });
  }

  async listPins(ctx: ReqCtx, channelId: common.ChannelId): Promise<ListPinsResponse> {
    const { channel } = await this.loadReadable(channelId, ctx.userId);
    await this.requireMember(channel, ctx.userId);
    const pins = await this.deps.repo.listPins(channel.id);
    const items: PinnedItem[] = [];
    for (const p of pins) {
      const msg = await this.deps.repo.getMessage(p.messageId);
      if (!msg) continue; // pinned message hard-gone -> drop from the list
      items.push({ ...p, message: await this.enrichOne(msg) });
    }
    return { items };
  }

  // ---- presence (online/away + status emoji/text) ----
  async setPresence(ctx: ReqCtx, body: SetPresenceRequest): Promise<PresenceView> {
    if (body.presence !== undefined && body.presence !== "auto" && body.presence !== "away") {
      throw errors.validationFailed([{ field: "presence", reason: "invalid" }]);
    }
    const now = this.deps.now();
    const existing = (await this.deps.repo.getPresence([ctx.userId]))[0] ?? null;
    const row: PresenceRow = {
      userId: ctx.userId,
      presence: body.presence ?? existing?.presence ?? "auto",
      statusEmoji: body.statusEmoji !== undefined ? body.statusEmoji : existing?.statusEmoji ?? null,
      statusText: body.statusText !== undefined ? body.statusText : existing?.statusText ?? null,
      statusExpiresAt: body.statusExpiresAt !== undefined ? body.statusExpiresAt : existing?.statusExpiresAt ?? null,
      lastActiveAt: now, // any presence write is also a heartbeat
      updatedAt: now,
    };
    await this.deps.repo.putPresence(row);
    return derivePresence(ctx.userId, row, Date.parse(now));
  }

  async getPresence(ctx: ReqCtx, userIds: common.UserId[]): Promise<GetPresenceResponse> {
    const unique = [...new Set(userIds.filter((u) => typeof u === "string" && u.length > 0))];
    if (unique.length === 0) throw errors.validationFailed([{ field: "userIds", reason: "required" }]);
    const rows = await this.deps.repo.getPresence(unique);
    const byId = new Map(rows.map((r) => [r.userId, r]));
    const nowMs = Date.parse(this.deps.now());
    return { items: unique.map((id) => derivePresence(id, byId.get(id) ?? null, nowMs)) };
  }

  // ---- ws-ticket (RT connect; DO-direct) ----
  async issueWsTicket(ctx: ReqCtx, id: common.ChannelId): Promise<WsTicketResponse> {
    const { channel } = await this.loadReadable(id, ctx.userId);
    await this.requireMember(channel, ctx.userId);
    const expEpochMs = ticketExpiryMs(Date.now());
    const ticket = await signWsTicket(this.deps.wsTicketSecret, { channelId: id, userId: ctx.userId, expEpochMs });
    return { ticket, doUrl: buildDoUrl(this.deps.doUrlBase, id), expiresAt: new Date(expEpochMs).toISOString() };
  }

  // ---- internal: system messages (notification -> chat delivery) ----
  async postSystemMessage(ctx: { requestId: string }, body: PostSystemMessageRequest): Promise<Message> {
    const text = requireBody(body.body);
    const hasChannel = typeof body.channelId === "string" && body.channelId.length > 0;
    const hasTarget = typeof body.targetUserId === "string" && body.targetUserId.length > 0;
    if (hasChannel === hasTarget) {
      throw errors.validationFailed([{ field: "channelId|targetUserId", reason: "exactly_one_required" }]);
    }

    let channelId: common.ChannelId;
    if (hasChannel) {
      const channel = await this.deps.repo.getChannel(body.channelId!);
      if (!channel) throw errors.notFound("channel", body.channelId!);
      if (channel.archivedAt) throw errArchived(channel.id);
      channelId = channel.id;
    } else {
      // resolve (or create) the system DM channel by dm_key (idempotent).
      const target = body.targetUserId!;
      const key = deriveDmKey([target]);
      const existing = await this.deps.repo.getChannelByDmKey(key);
      const now = this.deps.now();
      if (existing) {
        channelId = existing.id;
      } else {
        const row: ChannelRow = {
          id: this.deps.newChannelId(),
          type: "dm",
          visibility: "private",
          name: "Direct messages",
          topic: null,
          eventId: null,
          dmKey: key,
          createdBy: target,
          archivedAt: null,
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        await this.deps.repo.createChannel(row);
        await this.deps.repo.addMember({ channelId: row.id, userId: target, role: "member", joinedAt: now });
        channelId = row.id;
      }
    }

    const now = this.deps.now();
    const row: MessageRow = {
      id: this.deps.newMessageId(),
      channelId,
      threadRootId: null,
      authorId: null,
      kind: "system",
      body: text,
      attachmentFileIds: [],
      version: 1,
      editedAt: null,
      deletedAt: null,
      createdAt: now,
    };
    await this.deps.repo.createMessage(row);
    // NOTE: system posts do NOT emit chat.message.created (frozen payload requires
    // a non-null authorId, and notification — the caller — already knows). RT is
    // likewise skipped for the same contract reason.
    await this.audit({ requestId: ctx.requestId, userId: null }, "chat.system.post", "message", row.id, {
      channelId,
      ...(body.meta ? { meta: body.meta } : {}),
    });
    return toMessage(row, {});
  }
}

// A malformed cursor is a client error (400), not a silent full scan.
function invalidCursor(raw: string): never {
  throw errors.validationFailed([{ field: "cursor", reason: "invalid", message: `unparseable cursor: ${raw.slice(0, 16)}` }]);
}
