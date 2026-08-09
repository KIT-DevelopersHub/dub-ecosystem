// In-memory ChatRealtimeClient for tests and standalone dev (no chat-service DO).
// Lets tests drive `message.created` etc. and simulate disconnect/reconnect.
import type { common } from "@dub/types";
import type { ChatRealtimeEvent, WsTicketResponse } from "../api/contract";
import type { ChatRealtimeClient, RealtimeStatus } from "./client";

export class MockRealtimeClient implements ChatRealtimeClient {
  private eventHandlers = new Set<(e: ChatRealtimeEvent) => void>();
  private statusHandlers = new Set<(s: RealtimeStatus) => void>();
  private status: RealtimeStatus = "connecting";
  channelId: common.ChannelId | null = null;
  lastTicket: WsTicketResponse | null = null;

  connect(channelId: common.ChannelId, ticket: WsTicketResponse): void {
    this.channelId = channelId;
    this.lastTicket = ticket;
    this.setStatus("open");
  }
  disconnect(): void {
    this.channelId = null;
    this.setStatus("closed");
  }
  onEvent(handler: (e: ChatRealtimeEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }
  onStatusChange(handler: (s: RealtimeStatus) => void): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }

  // ---- test drivers ----
  emit(event: ChatRealtimeEvent): void {
    for (const h of this.eventHandlers) h(event);
  }
  setStatus(s: RealtimeStatus): void {
    this.status = s;
    for (const h of this.statusHandlers) h(s);
  }
}
