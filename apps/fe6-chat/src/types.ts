// FE6 internal view-model types (design §2-5). Distinct from the wire contract in
// api/contract.ts — these model client-side state (optimistic pending, RT status).
import type { common } from "@dub/types";
import type { Message, PostMessageRequest } from "./api/contract";
import type { RealtimeStatus } from "./realtime/client";

export interface PendingMessage {
  clientTempId: string; // replaced by the server ULID on ack
  request: PostMessageRequest;
  authorId: common.UserId; // the current user (for RT echo dedupe)
  state: "sending" | "failed";
  createdAt: common.ISODateTime;
}

export interface ChannelViewState {
  channelId: common.ChannelId;
  messages: Message[]; // ULID ascending, deduped by id
  pending: PendingMessage[];
  nextCursor: string | null; // older-history cursor (null = start of history)
  lastReadMessageId: common.MessageId | null;
  unreadCount: number;
  rtStatus: RealtimeStatus;
}

export function emptyChannelView(channelId: common.ChannelId): ChannelViewState {
  return {
    channelId,
    messages: [],
    pending: [],
    nextCursor: null,
    lastReadMessageId: null,
    unreadCount: 0,
    rtStatus: "connecting",
  };
}
