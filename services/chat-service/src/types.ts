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
  replyCount: number; // visible thread replies (0 for replies themselves) — Slack "N replies"
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

// ---- mark-unread (Slack "Mark as unread") ----
// Sets the caller's read cursor to just BEFORE `messageId`, so `messageId` becomes the
// first unread. If it is the channel's first message the cursor is cleared (all unread).
export interface MarkUnreadRequest {
  messageId: common.MessageId;
}

// ---- search (full-text over the caller's channels; Slack in:/from: filters) ----
export interface SearchMessagesQuery extends common.CursorQuery {
  q: string; // substring match over message body (case-insensitive)
  in?: common.ChannelId; // Slack `in:#channel` — restrict to one channel (membership required)
  from?: common.UserId; // Slack `from:@user` — restrict to one author
}
export type SearchMessagesResponse = common.Paginated<Message>;

// ---- pins (channel pinned items) ----
export interface PinMessageRequest {
  messageId: common.MessageId;
}
export interface PinnedItem {
  channelId: common.ChannelId;
  messageId: common.MessageId;
  pinnedBy: common.UserId;
  pinnedAt: common.ISODateTime;
  message: Message; // embedded so the FE renders the pinned list without N extra fetches
}
export interface ListPinsResponse {
  items: PinnedItem[];
}

// ---- presence (online/away + status emoji/text) ----
export type PresenceSetting = "auto" | "away"; // what the user chose
export type PresenceState = "active" | "away"; // effective (derived from lastActiveAt)
export interface SetPresenceRequest {
  presence?: PresenceSetting; // omit = heartbeat only (refresh lastActiveAt)
  statusEmoji?: string | null;
  statusText?: string | null;
  statusExpiresAt?: common.ISODateTime | null; // status auto-clears at/after this instant
}
export interface PresenceView {
  userId: common.UserId;
  state: PresenceState;
  statusEmoji: string | null;
  statusText: string | null;
  lastActiveAt: common.ISODateTime | null; // null = never seen (no presence row)
}
export interface GetPresenceResponse {
  items: PresenceView[];
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
export interface PinRow {
  channelId: common.ChannelId;
  messageId: common.MessageId;
  pinnedBy: common.UserId;
  pinnedAt: common.ISODateTime;
}
export interface PresenceRow {
  userId: common.UserId;
  presence: PresenceSetting;
  statusEmoji: string | null;
  statusText: string | null;
  statusExpiresAt: common.ISODateTime | null;
  lastActiveAt: common.ISODateTime;
  updatedAt: common.ISODateTime;
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
  updateMessage(next: MessageRow, expectedVersion: number): Promise<boolean>;
  // thread reply counts (visible replies grouped by root) — Slack "N replies"
  replyCountsFor(rootIds: common.MessageId[]): Promise<Map<common.MessageId, number>>;
  // id of the message immediately before `messageId` in the channel (mark-unread)
  previousMessageId(channelId: common.ChannelId, messageId: common.MessageId): Promise<common.MessageId | null>;
  // full-text search over the caller's channels (LIKE keyset scan, desc by id)
  searchMessages(q: {
    channelIds: common.ChannelId[];
    text: string;
    fromUserId?: common.UserId;
    beforeId?: string;
    limit: number;
  }): Promise<MessageRow[]>;

  // reactions
  hasReaction(messageId: common.MessageId, emoji: string, userId: common.UserId): Promise<boolean>;
  addReaction(messageId: common.MessageId, emoji: string, userId: common.UserId, at: string): Promise<void>;
  removeReaction(messageId: common.MessageId, emoji: string, userId: common.UserId): Promise<boolean>;
  reactionsFor(messageIds: common.MessageId[]): Promise<Map<string, Record<string, common.UserId[]>>>;

  // read states
  setReadState(channelId: common.ChannelId, userId: common.UserId, lastReadMessageId: common.MessageId, at: string): Promise<void>;
  clearReadState(channelId: common.ChannelId, userId: common.UserId): Promise<void>;
  getReadState(channelId: common.ChannelId, userId: common.UserId): Promise<{ lastReadMessageId: common.MessageId | null } | null>;
  countUnread(channelId: common.ChannelId, userId: common.UserId, lastReadMessageId: common.MessageId | null): Promise<number>;

  // pins
  addPin(row: PinRow): Promise<void>;
  removePin(channelId: common.ChannelId, messageId: common.MessageId): Promise<boolean>;
  listPins(channelId: common.ChannelId): Promise<PinRow[]>;

  // presence
  getPresence(userIds: common.UserId[]): Promise<PresenceRow[]>;
  putPresence(row: PresenceRow): Promise<void>;
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
