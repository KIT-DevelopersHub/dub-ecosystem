// FE6 local view of the chat-service HTTP contract consumed via api-gateway.
//
// The frozen @dub/types `chat` namespace only carries the RT wire contract
// (ChatRealtimeEvent, WsTicketResponse) plus STUB Channel/Message shells, because
// chat-service is △ (9-C activation pending). Per FE6 design §5 ("契約名のみ依存")
// FE6 implements against the *expected* contract + mock server until chat-service
// freezes the rest. These types are that expected contract; they DO NOT redefine
// anything already frozen — RT types are imported from @dub/types and re-exported.
//
// IDs / pagination / optimistic-lock come from @dub/types common (single source).
import type { common, chat } from "@dub/types";

// Re-export the frozen RT wire contract so the unit has one import surface.
// (@dub/types exposes namespaces via the package root only — no `/chat` subpath.)
export type ChatRealtimeEvent = chat.ChatRealtimeEvent;
export type WsTicketResponse = chat.WsTicketResponse;

export type ChannelType = "topic" | "event" | "dm";
export type ChannelVisibility = "public" | "private";
export type MemberRole = "admin" | "member";

export interface Reaction {
  emoji: string;
  userIds: common.UserId[];
}

export interface Attachment {
  fileId: common.FileId;
  name: string;
  mime: string;
  size: number;
  // Preview URL (data: URL in standalone/mock; object storage URL when served by
  // file-meta). Optional so the frozen upload hand-off (fileId only) still holds.
  url?: string | null;
}

export interface Channel extends common.Versioned {
  id: common.ChannelId;
  orgId: common.OrgId;
  type: ChannelType;
  visibility: ChannelVisibility; // "private" channels show a lock and are invite-only
  name: string;
  topic: string | null;
  eventId: common.EventId | null; // set when type === "event"
  archived: boolean;
  memberCount: number;
  createdAt: common.ISODateTime;
  updatedAt: common.ISODateTime;
}

export interface ChannelMember {
  channelId: common.ChannelId;
  userId: common.UserId;
  role: MemberRole;
  joinedAt: common.ISODateTime;
}

// GetChannelResponse — chat review #14 (detail + caller's own membership).
export interface GetChannelResponse {
  channel: Channel;
  membership: ChannelMember | null;
}

export interface Message extends common.Versioned {
  id: common.MessageId; // ULID — ascending order is chronological
  channelId: common.ChannelId;
  authorId: common.UserId;
  body: string; // Markdown subset; mentions encoded as <@userId>
  threadRootId: common.MessageId | null; // null = top-level
  replyCount: number;
  reactions: Reaction[];
  attachments: Attachment[];
  editedAt: common.ISODateTime | null;
  deletedAt: common.ISODateTime | null; // set = tombstone (render as redacted)
  createdAt: common.ISODateTime;
}

export interface CreateChannelRequest {
  type: ChannelType;
  visibility?: ChannelVisibility; // defaults to "public"
  name: string;
  topic?: string;
  eventId?: common.EventId; // required when type === "event"
}

export interface UpdateChannelRequest {
  name?: string;
  topic?: string | null;
  archived?: boolean;
  version: number; // optimistic lock
}

// GET /messages?channelId=&cursor=&limit=&threadRootId=&afterMessageId=
// afterMessageId is the RT gap-fill hint (design §8-2 A). Server returns ULID
// ascending when afterMessageId is set; descending page otherwise.
export interface ListMessagesRequest {
  channelId: common.ChannelId;
  cursor?: string;
  limit?: number;
  threadRootId?: common.MessageId;
  afterMessageId?: common.MessageId;
}
export type ListMessagesResponse = common.Paginated<Message>;

export interface PostMessageRequest {
  channelId: common.ChannelId;
  body: string;
  threadRootId?: common.MessageId;
  attachments?: Attachment[];
  clientTempId: string; // echoed back so the optimistic entry can be reconciled
}
export interface PostMessageResponse {
  message: Message;
  clientTempId: string;
}

export interface EditMessageRequest {
  body: string;
  version: number;
}

export interface ReactionToggleRequest {
  emoji: string;
}
// A reaction toggle returns only the affected message's authoritative reaction set
// (not the whole message) — chat-service's ReactionToggleResponse. The client applies
// these onto the existing timeline message (see store/timeline applyReactions).
export interface ReactionToggleResponse {
  messageId: common.MessageId;
  reactions: Reaction[];
}

export interface ReadStateUpdateRequest {
  channelId: common.ChannelId;
  lastReadMessageId: common.MessageId;
}

export interface UnreadSummary {
  channelId: common.ChannelId;
  unreadCount: number;
  lastReadMessageId: common.MessageId | null;
  mentioned: boolean;
}

// A search match: the message plus enough channel context to render + navigate.
export interface SearchHit {
  message: Message;
  channelId: common.ChannelId;
  channelName: string;
  channelType: ChannelType;
}

export interface SearchMessagesRequest {
  q: string;
  channelId?: common.ChannelId; // scope to one channel; omit = workspace-wide
  limit?: number;
}
