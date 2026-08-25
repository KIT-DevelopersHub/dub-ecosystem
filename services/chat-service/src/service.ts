// Business logic for chat (channels / members / messages / reactions / read /
// ws-ticket / system posts). Pure of HTTP: parsed inputs + a request context in,
// DubError thrown, wire DTOs out. The Hono app is a thin adapter over this.
//
// Ordering rule (design §4): domain events are published AFTER the DB write
// (post-commit) so a failed write never emits. Audit for delete/archive uses
// Queue publishAudit (design §4 / theme13).
import { DubError, CommonErrorCodes, errors } from "@dub/errors";
import { chat, type common, type auditLog } from "@dub/types";
import type {
  AppDeps,
  Channel,
  ChannelRow,
  CreateChannelRequest,
  UpdateChannelRequest,
  AddMemberRequest,
  DeleteMessageResult,
  DeletionPolicyResponse,
  GetChannelResponse,
  ListChannelsResponse,
  ListMessagesResponse,
  Message,
  MessageRow,
  MemberRow,
  MessageDeletionMode,
  MessageDeletionPolicy,
  PostMessageRequest,
  PostSystemMessageRequest,
  ReactionToggleResponse,
  ReadStateUpdateRequest,
  ChannelMember,
  SearchHit,
  UnreadResponse,
  UnreadSummary,
  UpdateDeletionPolicyRequest,
  WsTicketResponse,
} from "./types";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_BODY_LEN,
  buildDoUrl,
  decodeCursor,
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

const DELETION_MODES: readonly MessageDeletionMode[] = ["hard", "tombstone"];
function requireMode(value: unknown, field: string): MessageDeletionMode {
  if (typeof value !== "string" || !DELETION_MODES.includes(value as MessageDeletionMode)) {
    throw errors.validationFailed([{ field, reason: "invalid" }]);
  }
  return value as MessageDeletionMode;
}
function requirePolicy(raw: unknown): MessageDeletionPolicy {
  if (typeof raw !== "object" || raw === null) throw errors.validationFailed([{ field: "policy", reason: "required" }]);
  const p = raw as Record<string, unknown>;
  return { member: requireMode(p.member, "policy.member"), moderator: requireMode(p.moderator, "policy.moderator") };
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

  // Write access. Members can always write. On a PUBLIC channel a non-member is
  // auto-joined on their first write (Slack-style "posting joins the channel"), so
  // send / react / pin work without an explicit join step — the base channels
  // (general/random/運営連絡) ship with no membership rows, so this is what makes
  // sending work at all. PRIVATE channels stay members-only (callers run loadReadable
  // first, which 404s private non-members before this point; the guard below is a
  // belt-and-braces 403 for any direct write path).
  private async ensureCanWrite(channel: ChannelRow, userId: common.UserId): Promise<MemberRow> {
    const existing = await this.deps.repo.getMember(channel.id, userId);
    if (existing) return existing;
    if (channel.visibility !== "public") {
      throw new DubError(CommonErrorCodes.FORBIDDEN, "not a channel member", { status: 403 });
    }
    const row: MemberRow = { channelId: channel.id, userId, role: "member", joinedAt: this.deps.now() };
    await this.deps.repo.addMember(row); // INSERT OR IGNORE — idempotent auto-join
    return row;
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

  // Members roster (FE6 presence / admin-badge popover). Any caller who can READ the
  // channel (member, or anyone for a public channel) may list its members; a private
  // channel stays hidden from non-members (loadReadable -> 404).
  async listMembers(ctx: ReqCtx, id: common.ChannelId): Promise<ChannelMember[]> {
    await this.loadReadable(id, ctx.userId);
    const rows = await this.deps.repo.listMembers(id);
    return rows.map(toMember);
  }

  // ---- messages ----
  async postMessage(ctx: ReqCtx, body: PostMessageRequest): Promise<Message> {
    const text = requireBody(body.body);
    const { channel } = await this.loadReadable(body.channelId, ctx.userId);
    await this.ensureCanWrite(channel, ctx.userId);
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
      threadRootId: row.threadRootId,
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
    // Reading is open on public channels (no join needed) — loadReadable already
    // blocks private channels for non-members (404, existence hidden). Membership is
    // only required to WRITE (post/react/pin), never to read a public channel.
    const { channel } = await this.loadReadable(q.channelId, ctx.userId);
    const limit = requireLimit(q.limit);

    if (q.afterMessageId !== undefined) {
      // asc gap-fill; bounded catch-up (client advances afterMessageId itself).
      const rows = await this.deps.repo.listMessages({
        channelId: channel.id,
        ...(q.threadRootId ? { threadRootId: q.threadRootId } : {}),
        afterMessageId: q.afterMessageId,
        limit,
      });
      return { items: await this.decorate(rows, q.threadRootId === undefined), nextCursor: null };
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
      items: await this.decorate(page, q.threadRootId === undefined),
      nextCursor: hasMore && last ? encodeCursor(last.id) : null,
    };
  }

  // Map rows -> wire messages with reactions and (for the top-level list only) each
  // message's thread reply count, so the client can show the "N 件の返信" summary.
  private async decorate(rows: MessageRow[], withReplyCounts: boolean): Promise<Message[]> {
    const reactions = await this.deps.repo.reactionsFor(rows.map((r) => r.id));
    const counts = withReplyCounts ? await this.deps.repo.replyCounts(rows.map((r) => r.id)) : undefined;
    return rows.map((r) => toMessage(r, reactions.get(r.id) ?? {}, counts?.get(r.id) ?? 0));
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
    const reactions = await this.deps.repo.reactionsFor([id]);
    // No chat.message.updated in the frozen catalog and no RT variant -> audit only.
    await this.audit(ctx, "chat.message.update", "message", id, null);
    return toMessage(next, reactions.get(id) ?? {});
  }

  // Resolve the org's effective deletion policy (in-code default when unset).
  private async resolvePolicy(): Promise<MessageDeletionPolicy> {
    const row = await this.deps.repo.getDeletionPolicy(this.deps.orgId);
    return row?.policy ?? chat.DEFAULT_MESSAGE_DELETION_POLICY;
  }

  // GET /chat/settings/deletion-policy — version 0 signals "no override, default in effect".
  async getDeletionPolicy(_ctx: ReqCtx): Promise<DeletionPolicyResponse> {
    const row = await this.deps.repo.getDeletionPolicy(this.deps.orgId);
    return row ? { policy: row.policy, version: row.version } : { policy: chat.DEFAULT_MESSAGE_DELETION_POLICY, version: 0 };
  }

  // PATCH /chat/settings/deletion-policy — optimistic-concurrency on `version`. Authz
  // (chat:moderate) is enforced at the route (fail-close); this only validates + writes.
  async updateDeletionPolicy(ctx: ReqCtx, body: UpdateDeletionPolicyRequest): Promise<DeletionPolicyResponse> {
    if (typeof body.version !== "number") throw errors.validationFailed([{ field: "version", reason: "required" }]);
    const policy = requirePolicy(body.policy);
    const res = await this.deps.repo.setDeletionPolicy({
      orgId: this.deps.orgId,
      policy,
      expectedVersion: body.version,
      updatedBy: ctx.userId,
      at: this.deps.now(),
    });
    if (!res) throw errVersionConflict("deletion-policy");
    await this.audit(ctx, "chat.settings.deletion_policy.update", "org", this.deps.orgId, { policy, version: res.version });
    return { policy, version: res.version };
  }

  async deleteMessage(ctx: ReqCtx, id: common.MessageId): Promise<DeleteMessageResult> {
    const msg = await this.deps.repo.getMessage(id);
    if (!msg) throw errors.notFound("message", id);
    const channel = await this.deps.repo.getChannel(msg.channelId);
    if (!channel) throw errors.notFound("message", id);
    const isAuthor = msg.authorId === ctx.userId;
    // Moderator tier = channel admin OR the chat:moderate permission (admin/maintainer).
    // Resolved server-side — the client never asserts its own tier (fail-close authz).
    const isModerator = await this.isChannelAdmin(ctx, channel);
    if (!isAuthor && !isModerator) {
      throw new DubError(CommonErrorCodes.FORBIDDEN, "author or channel admin required", { status: 403 });
    }
    // Idempotent: an already-tombstoned message stays a tombstone.
    if (msg.deletedAt) return { mode: "tombstone", message: toMessage(msg, {}) };

    const policy = await this.resolvePolicy();
    const mode: MessageDeletionMode = isModerator ? policy.moderator : policy.member;
    const now = this.deps.now();

    let outMessage: Message | null;
    if (mode === "hard") {
      // Physical erase: the row (and its reactions / pins / thread replies) is gone —
      // it vanishes from the timeline, lists and unread counts. No tombstone remains.
      await this.deps.repo.hardDeleteMessage(id);
      outMessage = null;
    } else {
      const next: MessageRow = { ...msg, deletedAt: now, version: msg.version + 1 };
      if (!(await this.deps.repo.updateMessage(next, msg.version))) throw errVersionConflict(id);
      outMessage = toMessage(next, {});
    }

    await this.deps.publisher.publish("chat.message.deleted", { channelId: channel.id, messageId: id }, this.actor(ctx));
    await this.deps.realtime.publishToChannel(channel.id, { kind: "message.deleted", channelId: channel.id, messageId: id, at: now, mode });
    // Audit always records who/when/mode (server-side, never surfaced in the UI).
    await this.audit(ctx, "chat.message.delete", "message", id, { channelId: channel.id, byAuthor: isAuthor, mode });
    return { mode, message: outMessage };
  }

  async toggleReaction(ctx: ReqCtx, id: common.MessageId, emoji: string): Promise<ReactionToggleResponse> {
    const clean = nonEmptyString(emoji, "emoji");
    const msg = await this.deps.repo.getMessage(id);
    if (!msg || msg.deletedAt) throw errors.notFound("message", id);
    const { channel } = await this.loadReadable(msg.channelId, ctx.userId);
    await this.ensureCanWrite(channel, ctx.userId);

    const has = await this.deps.repo.hasReaction(id, clean, ctx.userId);
    if (has) await this.deps.repo.removeReaction(id, clean, ctx.userId);
    else await this.deps.repo.addReaction(id, clean, ctx.userId, this.deps.now());
    const reactions = await this.deps.repo.reactionsFor([id]);
    return { messageId: id, reactions: reactions.get(id) ?? {} };
  }

  // ---- search (workspace / single-channel; readable scope enforced in the repo) ----
  async search(ctx: ReqCtx, q: { q?: string; channelId?: common.ChannelId; limit?: number }): Promise<SearchHit[]> {
    // Empty / whitespace query -> no results (matches the FE contract; not a 400).
    const text = (typeof q.q === "string" ? q.q : "").trim();
    if (text.length === 0) return [];
    const limit = requireLimit(q.limit);
    const rows = await this.deps.repo.searchMessages({
      userId: ctx.userId,
      text,
      ...(q.channelId ? { channelId: q.channelId } : {}),
      limit,
    });
    const reactions = await this.deps.repo.reactionsFor(rows.map((r) => r.message.id));
    return rows.map((r) => ({
      message: toMessage(r.message, reactions.get(r.message.id) ?? {}),
      channelId: r.message.channelId,
      channelName: r.channelName,
      channelType: r.channelType,
    }));
  }

  // ---- pins ----
  private async pinnedList(channelId: common.ChannelId): Promise<Message[]> {
    const rows = await this.deps.repo.listPinnedMessages(channelId);
    const reactions = await this.deps.repo.reactionsFor(rows.map((r) => r.id));
    return rows.map((r) => toMessage(r, reactions.get(r.id) ?? {}));
  }

  // List a channel's pinned messages. Readable scope (member, or public channel).
  async listPins(ctx: ReqCtx, id: common.ChannelId): Promise<Message[]> {
    await this.loadReadable(id, ctx.userId);
    return this.pinnedList(id);
  }

  // Toggle a pin (Slack: any channel member may pin/unpin). Returns the updated list so
  // the FE can reconcile in one round-trip. Not in the frozen RT/event catalog -> audit only.
  async togglePin(ctx: ReqCtx, id: common.ChannelId, messageId: common.MessageId): Promise<Message[]> {
    const cleanMessageId = nonEmptyString(messageId, "messageId");
    const { channel } = await this.loadReadable(id, ctx.userId);
    await this.ensureCanWrite(channel, ctx.userId);
    if (channel.archivedAt) throw errArchived(channel.id);

    const msg = await this.deps.repo.getMessage(cleanMessageId);
    if (!msg || msg.deletedAt || msg.channelId !== channel.id) {
      throw errors.validationFailed([{ field: "messageId", reason: "not_in_channel" }]);
    }

    const pinned = await this.deps.repo.isPinned(channel.id, cleanMessageId);
    if (pinned) await this.deps.repo.removePin(channel.id, cleanMessageId);
    else await this.deps.repo.addPin(channel.id, cleanMessageId, ctx.userId, this.deps.now());
    await this.audit(ctx, pinned ? "chat.message.unpin" : "chat.message.pin", "message", cleanMessageId, { channelId: channel.id });
    return this.pinnedList(channel.id);
  }

  // ---- read state / unread ----
  async updateReadState(ctx: ReqCtx, id: common.ChannelId, body: ReadStateUpdateRequest): Promise<UnreadSummary> {
    const lastReadMessageId = nonEmptyString(body.lastReadMessageId, "lastReadMessageId");
    // Marking read is a read-side action: allowed on any readable channel (public
    // without join; private members-only via loadReadable). No write membership gate.
    await this.loadReadable(id, ctx.userId);
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

  // ---- ws-ticket (RT connect; DO-direct) ----
  async issueWsTicket(ctx: ReqCtx, id: common.ChannelId): Promise<WsTicketResponse> {
    // Realtime subscribe follows read access: public channels are open to any
    // authenticated user (loadReadable blocks private non-members). The ChatRoom DO
    // still verifies the HMAC ticket + Origin, so this issuance is the read gate.
    await this.loadReadable(id, ctx.userId);
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
