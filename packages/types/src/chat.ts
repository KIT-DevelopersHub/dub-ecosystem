// chat — chat-service namespace. RT contract frozen; channel/message CRUD is STUB
// pending 9-C activation. RT土台 = Durable Objects (WS is gateway-bypassing, DO-direct).
import type { ChannelId, MessageId, UserId, ISODateTime } from "./common";

// Server-internal fanout contract AND client WS wire contract (frozen · RT裁定#4).
export type ChatRealtimeEvent =
  | { kind: "message.created"; channelId: ChannelId; messageId: MessageId; authorId: UserId; body: string; at: ISODateTime }
  | { kind: "message.deleted"; channelId: ChannelId; messageId: MessageId; at: ISODateTime }
  | { kind: "member.added"; channelId: ChannelId; userId: UserId; at: ISODateTime }
  | { kind: "member.removed"; channelId: ChannelId; userId: UserId; at: ISODateTime };

export interface WsTicketResponse {
  ticket: string; // short-lived; verified by the ChatRoom DO
  doUrl: string; // absolute URL to the Durable Object (DO-direct, gateway bypassed)
  expiresAt: ISODateTime;
}

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
