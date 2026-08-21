// Service-local types for chat-service.
//
// FROZEN vs DRAFT: @dub/types `chat` namespace is a STUB pending 9-C (it carries
// only the RT wire contract: ChatRealtimeEvent + WsTicketResponse). The rich
// channel/message wire DTOs below are the design-P0a contract (chat-service.md §2)
// that will be lifted into @dub/types `chat` once 9-C freezes the DDL. They live
// here for now so this unit does not mutate the shared package (unit boundary).
// The @dub/events chat payloads ARE frozen and are used verbatim by the service.
import type { common, auditLog, identity, chat } from "@dub/types";
import type { MiddlewareHandler, Context } from "hono";
import type { DubEventName, DubEventPayloadMap } from "@dub/events";

// ---- wire enums (design §2) ----
export type ChannelType = "event" | "topic" | "dm";
export type ChannelVisibility = "public" | "private";
export type ChannelRole = "admin" | "member";
export type MessageKind = "user" | "system";

// ---- wire DTOs (design §2 — move to @dub/types chat after 9-C) ----
export interface Channel {
  id: common.ChannelId;
  type: ChannelType;
  visibility: ChannelVisibility;
  name: string;
  topic: string | null;
  eventId: common.EventId | null;
  createdBy: common.UserId;
  archivedAt: common.ISODateTime | null;
  version: number;
  createdAt: common.ISODateTime;
  updatedAt: common.ISODateTime;
}

export interface ChannelMember {
  channelId: common.ChannelId;
  userId: common.UserId;
  role: ChannelRole;
  joinedAt: common.ISODateTime;
}

export interface GetChannelResponse {
  channel: Channel;
  membership: ChannelMember | null; // null = non-member viewing a public channel
}

export interface Message {
  id: common.MessageId;
  channelId: common.ChannelId;
  threadRootId: common.MessageId | null;
  authorId: common.UserId | null; // null = system post (kind = "system")
  kind: MessageKind;
  body: string; // logically-deleted messages return a redacted body
  attachmentFileIds: common.FileId[];
  reactions: Record<string, common.UserId[]>; // emoji -> userId[]
  replyCount: number; // thread replies to this message (top-level list only; 0 otherwise)
  version: number;
  editedAt: common.ISODateTime | null;
  deletedAt: common.ISODateTime | null;
  createdAt: common.ISODateTime;
}

// ---- request/response contracts ----
export interface CreateChannelRequest {
  type: ChannelType;
  visibility: ChannelVisibility;
  name: string;
  topic?: string;
  eventId?: common.EventId;
  memberIds?: common.UserId[];
}
export interface UpdateChannelRequest extends common.Versioned {
  name?: string;
  topic?: string | null;
  archived?: boolean;
}
export interface AddMemberRequest {
  userId: common.UserId;
  role?: ChannelRole;
}
export type ListChannelsResponse = common.Paginated<Channel>;

export interface ListMessagesQuery extends common.CursorQuery {
  channelId: common.ChannelId;
  threadRootId?: common.MessageId;
  afterMessageId?: common.MessageId; // asc gap-fill; exclusive with cursor
}
export type ListMessagesResponse = common.Paginated<Message>;

export interface PostMessageRequest {
  channelId: common.ChannelId;
  body: string;
  threadRootId?: common.MessageId;
  attachmentFileIds?: common.FileId[];
}

export interface PostSystemMessageRequest {
  channelId?: common.ChannelId; // exactly one of channelId / targetUserId
  targetUserId?: common.UserId; // resolve (or create) the DM channel by dm_key
  body: string;
  meta?: Record<string, unknown>;
}

export interface ReadStateUpdateRequest {
  channelId: common.ChannelId;
  lastReadMessageId: common.MessageId;
}
export interface UnreadSummary {
  channelId: common.ChannelId;
  unreadCount: number;
  lastReadMessageId: common.MessageId | null;
}
export interface UnreadResponse {
  items: UnreadSummary[];
}

export interface ReactionToggleRequest {
  emoji: string;
}
export interface ReactionToggleResponse {
  messageId: common.MessageId;
  reactions: Record<string, common.UserId[]>;
}

// ---- search (Slack-parity workspace/channel search) ----
export interface SearchMessagesQuery {
  q: string;
  channelId?: common.ChannelId; // scope to one channel; omit = all readable channels
  limit?: number;
}
// A search match: the message + enough channel context for the FE to render/navigate.
export interface SearchHit {
  message: Message;
  channelId: common.ChannelId;
  channelName: string;
  channelType: ChannelType;
}

// ---- message deletion policy (RBAC-configurable delete behaviour) ----
// The policy shape + default are frozen in @dub/types (single source of truth);
// re-export under local names so the service reads one contract.
export type MessageDeletionMode = chat.MessageDeletionMode;
export type MessageDeletionPolicy = chat.MessageDeletionPolicy;
export type DeletionPolicyResponse = chat.DeletionPolicyResponse;
export type UpdateDeletionPolicyRequest = chat.UpdateDeletionPolicyRequest;

// DELETE /chat/messages/:id envelope. `mode` = how the policy resolved the delete;
// `message` = the redacted tombstone (mode="tombstone") or null (mode="hard").
export interface DeleteMessageResult {
  mode: MessageDeletionMode;
  message: Message | null;
}

// The stored policy plus its optimistic-concurrency version (0 = no row yet / default).
export interface DeletionPolicyRow {
  policy: MessageDeletionPolicy;
  version: number;
}

// ---- pins (Slack-parity pinned messages) ----
export interface PinToggleRequest {
  messageId: common.MessageId;
}
// A message row joined with its channel context, as returned by repo.searchMessages.
export interface SearchRow {
  message: MessageRow;
  channelName: string;
  channelType: ChannelType;
}

// WsTicketResponse is frozen in @dub/types (chat); re-export under the local name.
export type WsTicketResponse = chat.WsTicketResponse;

// ---- internal persistence rows (superset; carries dmKey, absent from wire) ----
export interface ChannelRow {
  id: common.ChannelId;
  type: ChannelType;
  visibility: ChannelVisibility;
  name: string;
  topic: string | null;
  eventId: common.EventId | null;
  dmKey: string | null; // type='dm' only: sorted-member-set hash (dedup)
  createdBy: common.UserId;
  archivedAt: common.ISODateTime | null;
  version: number;
  createdAt: common.ISODateTime;
  updatedAt: common.ISODateTime;
}
export interface MemberRow {
  channelId: common.ChannelId;
  userId: common.UserId;
  role: ChannelRole;
  joinedAt: common.ISODateTime;
}
export interface MessageRow {
  id: common.MessageId;
  channelId: common.ChannelId;
  threadRootId: common.MessageId | null;
  authorId: common.UserId | null;
  kind: MessageKind;
  body: string;
  attachmentFileIds: common.FileId[];
  version: number;
  editedAt: common.ISODateTime | null;
  deletedAt: common.ISODateTime | null;
  createdAt: common.ISODateTime;
}

// ---- injected dependencies (enables full HTTP-level tests with fakes) ----
export interface EventPublisher {
  publish<N extends DubEventName>(
    name: N,
    payload: DubEventPayloadMap[N],
    ctx: { requestId: string; actorId: string | null },
  ): Promise<void>;
}

export interface AuditSink {
  record(input: auditLog.AuditRecordInput): Promise<void>;
}

// RT contract (design §2 / theme11). The real impl is the chat-owned ChatRoom DO
// (WS fanout); P0 wires a no-op. Only the frozen ChatRealtimeEvent variants are
// emitted (message.created / message.deleted / member.added / member.removed).
export interface RealtimePublisher {
  publishToChannel(channelId: common.ChannelId, event: chat.ChatRealtimeEvent): Promise<void>;
}

// Subset of @dub/auth-client's AuthClient the app consumes; the real client
// satisfies it, tests inject a fake.
export interface Authz {
  requireAuth(): MiddlewareHandler;
  requirePermission(
    permission: identity.PermissionKey,
    resolve?: (c: Context) => { orgId?: string; resourceType?: string; resourceId?: string },
  ): MiddlewareHandler;
  hasPermission(
    userId: common.UserId,
    orgId: common.OrgId,
    query: identity.AuthzQuery,
  ): Promise<boolean>;
}

// event-service existence check for event-type channels (design §5). Default impl
// returns true when SVC_EVENT is absent (local/preview); tests inject a fake.
export interface EventClient {
  eventExists(ctx: { requestId: string; userId?: string }, eventId: common.EventId): Promise<boolean>;
}

// file-meta link registration for attachments (design §5 / §8#3). Best-effort in
// P0; the link registry (file_meta_links) is file-meta's source of truth.
export interface FileClient {
  registerLinks(
    ctx: { requestId: string; userId?: string },
    messageId: common.MessageId,
    fileIds: common.FileId[],
  ): Promise<void>;
}

export interface ChatRepo {
  // channels
  createChannel(row: ChannelRow): Promise<void>;
  getChannel(id: common.ChannelId): Promise<ChannelRow | null>;
  getChannelByDmKey(dmKey: string): Promise<ChannelRow | null>;
  listChannelsForUser(q: {
    userId: common.UserId;
    eventId?: common.EventId;
    includeArchived: boolean;
    limit: number;
    afterId?: string;
  }): Promise<ChannelRow[]>;
  updateChannel(next: ChannelRow, expectedVersion: number): Promise<boolean>;

  // members
  addMember(row: MemberRow): Promise<void>;
  removeMember(channelId: common.ChannelId, userId: common.UserId): Promise<boolean>;
  getMember(channelId: common.ChannelId, userId: common.UserId): Promise<MemberRow | null>;
  listMembers(channelId: common.ChannelId): Promise<MemberRow[]>;
  membershipsForUser(userId: common.UserId): Promise<MemberRow[]>;

  // messages
  createMessage(row: MessageRow): Promise<void>;
  getMessage(id: common.MessageId): Promise<MessageRow | null>;
  listMessages(q: {
    channelId: common.ChannelId;
    threadRootId?: common.MessageId;
    afterMessageId?: common.MessageId; // asc
    beforeId?: string; // cursor: id < beforeId, desc
    limit: number;
  }): Promise<MessageRow[]>;
  /** Count non-deleted thread replies per root message id (for the top-level list summary). */
  replyCounts(rootIds: common.MessageId[]): Promise<Map<string, number>>;
  updateMessage(next: MessageRow, expectedVersion: number): Promise<boolean>;

  // reactions
  hasReaction(messageId: common.MessageId, emoji: string, userId: common.UserId): Promise<boolean>;
  /** True if the message has at least one reaction (any emoji, any user) — backs the
   *  reaction-protection delete guard. */
  messageHasReactions(messageId: common.MessageId): Promise<boolean>;
  addReaction(messageId: common.MessageId, emoji: string, userId: common.UserId, at: string): Promise<void>;
  removeReaction(messageId: common.MessageId, emoji: string, userId: common.UserId): Promise<boolean>;
  reactionsFor(messageIds: common.MessageId[]): Promise<Map<string, Record<string, common.UserId[]>>>;

  // read states
  setReadState(channelId: common.ChannelId, userId: common.UserId, lastReadMessageId: common.MessageId, at: string): Promise<void>;
  getReadState(channelId: common.ChannelId, userId: common.UserId): Promise<{ lastReadMessageId: common.MessageId | null } | null>;
  countUnread(channelId: common.ChannelId, userId: common.UserId, lastReadMessageId: common.MessageId | null): Promise<number>;

  // pins (channel-scoped; newest-pinned message first, tombstones excluded)
  listPinnedMessages(channelId: common.ChannelId): Promise<MessageRow[]>;
  isPinned(channelId: common.ChannelId, messageId: common.MessageId): Promise<boolean>;
  addPin(channelId: common.ChannelId, messageId: common.MessageId, userId: common.UserId, at: string): Promise<void>;
  removePin(channelId: common.ChannelId, messageId: common.MessageId): Promise<boolean>;

  // search: substring match over readable channels (public OR the caller is a member),
  // tombstones excluded, newest-first, bounded by limit.
  searchMessages(q: {
    userId: common.UserId;
    text: string;
    channelId?: common.ChannelId;
    limit: number;
  }): Promise<SearchRow[]>;

  // deletion policy (org-scoped; null = no override row yet -> in-code default)
  getDeletionPolicy(orgId: common.OrgId): Promise<DeletionPolicyRow | null>;
  /** Upsert with optimistic-concurrency on `expectedVersion` (0 = insert first row).
   *  Returns the new version on success, or null on a version conflict. */
  setDeletionPolicy(input: {
    orgId: common.OrgId;
    policy: MessageDeletionPolicy;
    expectedVersion: number;
    updatedBy: common.UserId | null;
    at: common.ISODateTime;
  }): Promise<{ version: number } | null>;

  /** Physically remove a message and its dependent rows (reactions, pins, and any
   *  thread replies rooted at it) — the `hard` delete path. Idempotent. */
  hardDeleteMessage(id: common.MessageId): Promise<void>;
}

export interface AppDeps {
  repo: ChatRepo;
  authz: Authz;
  publisher: EventPublisher;
  audit: AuditSink;
  realtime: RealtimePublisher;
  eventClient: EventClient;
  fileClient: FileClient;
  orgId: common.OrgId;
  wsTicketSecret: string;
  doUrlBase: string; // absolute; ":id" -> channelId
  now: () => string;
  newChannelId: () => common.ChannelId;
  newMessageId: () => common.MessageId;
}
