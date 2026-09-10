/// <reference lib="dom" />
// DO-direct WebSocket implementation of ChatRealtimeClient (theme11). Connects to
// WsTicketResponse.doUrl (absolute wss:// URL of the chat-owned RT Worker); the
// gateway is NOT on the WS path. Short-lived ticket is re-fetched on every
// (re)connect via `getTicket`; reconnect uses exponential backoff with jitter.
import type { common } from "@dub/types";
import type { ChatRealtimeEvent, WsTicketResponse } from "../api/contract";
import { backoffDelay, type ChatRealtimeClient, type RealtimeStatus } from "./client";

type WsFactory = (url: string) => WebSocket;

export interface WsChatClientOptions {
  // Re-fetch a fresh ticket for the channel on each connect (tickets are ~60s).
  getTicket: (channelId: common.ChannelId) => Promise<WsTicketResponse>;
  wsFactory?: WsFactory;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (h: number) => void;
  maxAttempts?: number; // 0 = unlimited
}

function isRealtimeEvent(v: unknown): v is ChatRealtimeEvent {
  if (v === null || typeof v !== "object") return false;
  const k = (v as { kind?: unknown }).kind;
  return (
    k === "message.created" ||
    k === "message.deleted" ||
    k === "member.added" ||
    k === "member.removed" ||
    k === "reaction.updated"
  );
}

export class WsChatClient implements ChatRealtimeClient {
  private readonly opts: Required<Omit<WsChatClientOptions, "getTicket">> & Pick<WsChatClientOptions, "getTicket">;
  private ws: WebSocket | null = null;
  private channelId: common.ChannelId | null = null;
  private attempt = 0;
  private closedByUser = false;
  private reconnectTimer: number | null = null;
  private status: RealtimeStatus = "closed";
  private eventHandlers = new Set<(e: ChatRealtimeEvent) => void>();
  private statusHandlers = new Set<(s: RealtimeStatus) => void>();

  constructor(options: WsChatClientOptions) {
    this.opts = {
      getTicket: options.getTicket,
      wsFactory: options.wsFactory ?? ((url) => new WebSocket(url)),
      setTimer: options.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number),
      clearTimer: options.clearTimer ?? ((h) => globalThis.clearTimeout(h)),
      maxAttempts: options.maxAttempts ?? 0,
    };
  }

  connect(channelId: common.ChannelId, ticket: WsTicketResponse): void {
    this.channelId = channelId;
    this.closedByUser = false;
    this.attempt = 0;
    this.open(ticket);
  }

  private open(ticket: WsTicketResponse): void {
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    // ticket is passed to the DO as a query param; the DO verifies it + Origin.
    const url = `${ticket.doUrl}${ticket.doUrl.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(ticket.ticket)}`;
    const ws = this.opts.wsFactory(url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.setStatus("open");
    };
    ws.onmessage = (ev: MessageEvent) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return; // ignore malformed frames
      }
      if (isRealtimeEvent(parsed)) {
        for (const h of this.eventHandlers) h(parsed);
      }
    };
    ws.onclose = () => this.scheduleReconnect();
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    };
  }

  private scheduleReconnect(): void {
    this.ws = null;
    if (this.closedByUser || this.channelId === null) {
      this.setStatus("closed");
      return;
    }
    if (this.opts.maxAttempts > 0 && this.attempt >= this.opts.maxAttempts) {
      this.setStatus("closed");
      return;
    }
    this.setStatus("reconnecting");
    const delay = backoffDelay(this.attempt);
    this.attempt++;
    this.reconnectTimer = this.opts.setTimer(() => {
      const channelId = this.channelId;
      if (channelId === null) return;
      // fresh ticket every reconnect (tickets are short-lived)
      this.opts
        .getTicket(channelId)
        .then((ticket) => {
          if (!this.closedByUser) this.open(ticket);
        })
        .catch(() => this.scheduleReconnect());
    }, delay);
  }

  disconnect(): void {
    this.closedByUser = true;
    this.channelId = null;
    if (this.reconnectTimer !== null) {
      this.opts.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
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

  private setStatus(s: RealtimeStatus): void {
    if (s === this.status) return;
    this.status = s;
    for (const h of this.statusHandlers) h(s);
  }
}
