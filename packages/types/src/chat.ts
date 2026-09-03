// chat — chat-service namespace. RT contract frozen; channel/message CRUD is STUB
// pending 9-C activation. RT土台 = Durable Objects (WS is gateway-bypassing, DO-direct).
import type { ChannelId, MessageId, UserId, EventId, ISODateTime, CursorQuery } from "./common";

// Server-internal fanout contract AND client WS wire contract (frozen · RT裁定#4).
export type ChatRealtimeEvent =
  | {
      kind: "message.created";
      channelId: ChannelId;
      messageId: MessageId;
      authorId: UserId;
      body: string;
      at: ISODateTime;
      // Present when the new message is a thread reply. Lets clients keep replies out of
      // the main timeline (they belong in the thread pane) and bump the root's reply
      // count live. Optional for backward-compat with older publishers.
      threadRootId?: MessageId | null;
    }
  | {
      kind: "message.deleted";
      channelId: ChannelId;
      messageId: MessageId;
      at: ISODateTime;
      // How the delete resolved under the workspace deletion policy. `hard` = the
      // message was physically removed (clients drop it from the timeline entirely,
      // no tombstone); `tombstone` = redacted-in-place (render "削除されました").
      // Optional for backward-compat with older publishers — a missing value is
      // treated as `tombstone` (the pre-policy behaviour).
      mode?: MessageDeletionMode;
    }
  | { kind: "member.added"; channelId: ChannelId; userId: UserId; at: ISODateTime }
  | { kind: "member.removed"; channelId: ChannelId; userId: UserId; at: ISODateTime };

// ---- message deletion policy (RBAC-configurable delete behaviour) ------------
// A deleted message is either HARD-removed (physically gone — vanishes from the
// timeline, list and unread counts, no trace) or TOMBSTONED (redacted-in-place,
// rendered as "このメッセージは削除されました"). The workspace picks the behaviour per
// privilege tier: `member` = a non-moderator deleting their own message; `moderator`
// = a `chat:moderate` holder (admin / maintainer). The tier is resolved server-side
// from the actor's permissions (never client-asserted). Default = every tier `hard`
// (今すぐの体感: 誰が消しても痕跡なく消える). ロール管理から将来 member="tombstone" に切替可能。
export type MessageDeletionMode = "hard" | "tombstone";

export interface MessageDeletionPolicy {
  /** Behaviour when a plain member (no `chat:moderate`) deletes their own message. */
  member: MessageDeletionMode;
  /** Behaviour when a moderator (holds `chat:moderate`: admin / maintainer) deletes. */
  moderator: MessageDeletionMode;
}

/** Product default: everyone's delete is a hard erase (no tombstone). */
export const DEFAULT_MESSAGE_DELETION_POLICY: MessageDeletionPolicy = {
  member: "hard",
  moderator: "hard",
};

/** GET /chat/settings/deletion-policy. `version` is 0 when no override row exists
 *  yet (the in-code default is in effect); it increments on each successful save
 *  and is echoed back into the PATCH for optimistic-concurrency. */
export interface DeletionPolicyResponse {
  policy: MessageDeletionPolicy;
  version: number;
}

/** PATCH /chat/settings/deletion-policy. `version` must equal the current one (0 for
 *  the first write) or the server answers 409. */
export interface UpdateDeletionPolicyRequest {
  policy: MessageDeletionPolicy;
  version: number;
}

// DELETE /chat/messages/:id returns { mode, message } where `mode` is how the policy
// resolved the delete and `message` is the redacted tombstone (mode="tombstone") or
// null (mode="hard", the row is gone). The envelope is typed locally by each consumer
// (chat-service / FE6) over their own wire Message; only `mode` is shared here.

export interface WsTicketResponse {
  ticket: string; // short-lived; verified by the ChatRoom DO
  doUrl: string; // absolute URL to the Durable Object (DO-direct, gateway bypassed)
  expiresAt: ISODateTime;
}

// ---- query contracts (server reads these; some were undocumented in the STUB spec) ----
export interface ListChannelsQuery extends CursorQuery {
  eventId?: EventId;
}
export interface ListMessagesQuery extends CursorQuery {
  channelId: ChannelId; // required
  threadRootId?: MessageId; // list a thread's replies
  afterMessageId?: MessageId; // catch-up fetch after a known message
}
export interface SearchMessagesQuery {
  q?: string;
  channelId?: ChannelId;
  limit?: number;
}

// ── Wire contract (query params) ─────────────────────────────────────────────
// SINGLE source of truth for the query-parameter *names* chat-service's read endpoints put
// on the wire. The server (chat-service app.ts) and the OpenAPI spec
// (docs/openapi/chat-service.yaml) are reconciled against this map in CI (see
// @dub/e2e-smoke wire-params.test.ts). The rest-STUB spec was missing listChannels' query
// params and the whole /chat/search + /chat/unread paths — added additively (existing
// behaviour unchanged). /chat/unread takes no query, so it has no entry here. See
// docs/api-contracts/_wire-contract-enforcement.md.
export const CHAT_WIRE = {
  listChannels: { method: "GET", path: "/chat/channels", query: ["cursor", "limit", "eventId"] },
  listMessages: {
    method: "GET",
    path: "/chat/messages",
    query: ["cursor", "limit", "channelId", "threadRootId", "afterMessageId"],
  },
  searchMessages: { method: "GET", path: "/chat/search", query: ["q", "channelId", "limit"] },
} as const;

// Compile-time tie: each endpoint's query keys must be real keys of its query type.
type _ChatWireKeysAreTyped =
  (typeof CHAT_WIRE.listChannels.query)[number] extends keyof ListChannelsQuery
    ? (typeof CHAT_WIRE.listMessages.query)[number] extends keyof ListMessagesQuery
      ? (typeof CHAT_WIRE.searchMessages.query)[number] extends keyof SearchMessagesQuery
        ? true
        : never
      : never
    : never;
const _chatWireKeyGuard: _ChatWireKeysAreTyped = true;
void _chatWireKeyGuard;

// STUB: 未決C(9-C) 有効化後に確定 ----------------------------------------------
export interface ChatChannel {
  id: ChannelId;
  name: string;
  createdAt: ISODateTime;
}
export interface ChatMessage {
  id: MessageId;
  channelId: ChannelId;
  // null = system post (chat-service `kind: "system"`, e.g. channel-created notices /
  // notification→chat delivery). Matches chat-service's wire (authorId: UserId | null);
  // the RT message.created event stays non-null since system posts do not emit it.
  authorId: UserId | null;
  body: string;
  createdAt: ISODateTime;
}
// -----------------------------------------------------------------------------
