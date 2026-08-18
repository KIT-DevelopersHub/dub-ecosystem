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
  | { kind: "message.deleted"; channelId: ChannelId; messageId: MessageId; at: ISODateTime }
  | { kind: "member.added"; channelId: ChannelId; userId: UserId; at: ISODateTime }
  | { kind: "member.removed"; channelId: ChannelId; userId: UserId; at: ISODateTime };

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
  authorId: UserId;
  body: string;
  createdAt: ISODateTime;
}
// -----------------------------------------------------------------------------
