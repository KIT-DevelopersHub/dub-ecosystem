// ChatRealtimeClient abstraction (design §2-5). RT土台 = Durable Objects (theme11);
// WS is DO-direct (gateway bypassed) — the client connects to WsTicketResponse.doUrl.
// The abstraction isolates transport so an Ably swap stays inside the adapter and
// UI code never changes.
import type { common } from "@dub/types";
import type { ChatRealtimeEvent, WsTicketResponse } from "../api/contract";

export type RealtimeStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface ChatRealtimeClient {
  connect(channelId: common.ChannelId, ticket: WsTicketResponse): void;
  disconnect(): void;
  onEvent(handler: (e: ChatRealtimeEvent) => void): () => void;
  onStatusChange(handler: (s: RealtimeStatus) => void): () => void;
}

// Reconnect backoff: exponential 1s -> 30s max, with ±20% jitter (design §2-5).
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 30000;

export function backoffDelay(attempt: number, rand: () => number = Math.random): number {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  const jitter = 1 + (rand() * 0.4 - 0.2); // ±20%
  return Math.round(exp * jitter);
}
