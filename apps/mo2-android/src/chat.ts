// ChatRepository (S10) — channel list + per-channel message store with optimistic
// send, mirroring TaskRepository's observable single-source-is-MO3 boundary (§2-2).
// Realtime is a Durable-Object-direct WebSocket (theme11, gateway-bypassed); at the
// client-core layer the WS is an *injected transport* (stubbed in tests), so this
// module owns only the reconcile logic (apply ChatRealtimeEvent -> message store).
// The Kotlin port keeps the same Flow<List<ChatMessageEntry>> boundary and wires an
// OkHttp WebSocket that fetches a ws-ticket via MobileBffClient.getChatWsTicket.
import type { chat, common } from "@dub/types";
import { AppErrorException, isAppErrorException, type AppError } from "./errors";
import type { MobileBffClient } from "./bff-client";

/** Delivery state of a message row (optimistic send lifecycle). */
export type ChatSendState = "pending" | "sent" | "failed";

/** A message plus its client-side delivery state. `localId` is set while pending/failed. */
export interface ChatMessageEntry {
  message: chat.ChatMessage;
  state: ChatSendState;
  localId?: string;
}

export type ChatSendResult =
  | { ok: true; message: chat.ChatMessage }
  | { ok: false; error: AppError; localId: string }; // entry left in "failed" state for retry

/** Injected realtime transport (DO-direct WS). connect returns a disconnect fn. */
export interface ChatRealtimeTransport {
  connect(channelId: common.ChannelId, onEvent: (e: chat.ChatRealtimeEvent) => void): () => void;
}

type ChannelListener = (channels: chat.ChatChannel[]) => void;
type MessageListener = (entries: ChatMessageEntry[]) => void;

export interface ChatRepositoryOptions {
  transport?: ChatRealtimeTransport;
  now?: () => string; // ISODateTime source (injectable for deterministic tests)
  localId?: () => string; // optimistic temp-id source
}

export class ChatRepository {
  private channels: chat.ChatChannel[] = [];
  private messages = new Map<common.ChannelId, ChatMessageEntry[]>();
  private channelListeners = new Set<ChannelListener>();
  private messageListeners = new Map<common.ChannelId, Set<MessageListener>>();
  private readonly now: () => string;
  private readonly mintLocalId: () => string;
  private localSeq = 0;

  constructor(
    private readonly client: MobileBffClient,
    private readonly opts: ChatRepositoryOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date().toISOString());
    this.mintLocalId = opts.localId ?? (() => `local_${++this.localSeq}`);
  }

  // ---- channels ----
  observeChannels(): chat.ChatChannel[] {
    return [...this.channels];
  }
  subscribeChannels(listener: ChannelListener): () => void {
    this.channelListeners.add(listener);
    return () => this.channelListeners.delete(listener);
  }
  async loadChannels(): Promise<void> {
    const page = await this.client.listChannels();
    this.channels = page.items;
    this.emitChannels();
  }

  // ---- messages ----
  observeMessages(channelId: common.ChannelId): ChatMessageEntry[] {
    return [...(this.messages.get(channelId) ?? [])];
  }
  subscribeMessages(channelId: common.ChannelId, listener: MessageListener): () => void {
    let set = this.messageListeners.get(channelId);
    if (!set) {
      set = new Set();
      this.messageListeners.set(channelId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
    };
  }

  /** Replace a channel's history from the server (pull-to-refresh / initial open). */
  async loadMessages(channelId: common.ChannelId): Promise<void> {
    const page = await this.client.listMessages(channelId);
    this.messages.set(
      channelId,
      page.items.map((message) => ({ message, state: "sent" as const })),
    );
    this.emitMessages(channelId);
  }

  /**
   * Optimistic send: append a pending row immediately, POST, then promote to the
   * authoritative server message on 200 (or mark failed on error). If realtime has
   * already delivered the same message, the pending row is reconciled, not duplicated.
   */
  async sendMessage(channelId: common.ChannelId, authorId: common.UserId, body: string): Promise<ChatSendResult> {
    const localId = this.mintLocalId();
    const optimistic: chat.ChatMessage = {
      id: localId,
      channelId,
      authorId,
      body,
      createdAt: this.now(),
    };
    this.append(channelId, { message: optimistic, state: "pending", localId });

    try {
      const saved = await this.client.postMessage(channelId, body);
      this.promote(channelId, localId, saved);
      return { ok: true, message: saved };
    } catch (err) {
      const error: AppError = isAppErrorException(err)
        ? err.appError
        : { kind: "Server", code: "UNKNOWN", requestId: null };
      this.mark(channelId, localId, "failed");
      return { ok: false, error, localId };
    }
  }

  // ---- realtime ----
  /** Wire the injected WS transport for a channel; returns a disconnect fn. */
  connectRealtime(channelId: common.ChannelId): () => void {
    if (!this.opts.transport) return () => {};
    return this.opts.transport.connect(channelId, (e) => this.applyRealtimeEvent(e));
  }

  /** Reconcile a frozen ChatRealtimeEvent into the message store (idempotent). */
  applyRealtimeEvent(e: chat.ChatRealtimeEvent): void {
    switch (e.kind) {
      case "message.created": {
        const incoming: chat.ChatMessage = {
          id: e.messageId,
          channelId: e.channelId,
          authorId: e.authorId,
          body: e.body,
          createdAt: e.at,
        };
        this.upsertFromRealtime(e.channelId, incoming);
        break;
      }
      case "message.deleted":
        this.remove(e.channelId, e.messageId);
        break;
      case "member.added":
      case "member.removed":
        // Membership changes do not affect the message store (out of P0 client-core).
        break;
      case "reaction.updated":
        // Reactions are not modelled in mo2-android's message store yet; ignore the frame.
        break;
    }
  }

  // ---- internals ----
  private list(channelId: common.ChannelId): ChatMessageEntry[] {
    let arr = this.messages.get(channelId);
    if (!arr) {
      arr = [];
      this.messages.set(channelId, arr);
    }
    return arr;
  }

  private append(channelId: common.ChannelId, entry: ChatMessageEntry): void {
    this.list(channelId).push(entry);
    this.emitMessages(channelId);
  }

  /** POST ack: replace the pending local row with the authoritative server message. */
  private promote(channelId: common.ChannelId, localId: string, saved: chat.ChatMessage): void {
    const arr = this.list(channelId);
    const idx = arr.findIndex((x) => x.localId === localId);
    if (arr.some((x) => x.message.id === saved.id && x.localId === undefined)) {
      // Realtime already delivered it -> drop the temp row, keep the confirmed one.
      if (idx !== -1) arr.splice(idx, 1);
    } else if (idx !== -1) {
      arr[idx] = { message: saved, state: "sent" };
    } else {
      arr.push({ message: saved, state: "sent" });
    }
    this.emitMessages(channelId);
  }

  private mark(channelId: common.ChannelId, localId: string, state: ChatSendState): void {
    const arr = this.list(channelId);
    const idx = arr.findIndex((x) => x.localId === localId);
    if (idx !== -1) {
      arr[idx] = { ...arr[idx]!, state };
      this.emitMessages(channelId);
    }
  }

  /** Realtime insert: dedupe by server id; promote a matching pending optimistic row. */
  private upsertFromRealtime(channelId: common.ChannelId, incoming: chat.ChatMessage): void {
    const arr = this.list(channelId);
    if (arr.some((x) => x.message.id === incoming.id && x.localId === undefined)) return; // already have it
    const pendingIdx = arr.findIndex(
      (x) => x.localId !== undefined && x.message.authorId === incoming.authorId && x.message.body === incoming.body,
    );
    if (pendingIdx !== -1) {
      arr[pendingIdx] = { message: incoming, state: "sent" }; // promote in place
    } else {
      arr.push({ message: incoming, state: "sent" });
    }
    this.emitMessages(channelId);
  }

  private remove(channelId: common.ChannelId, messageId: common.MessageId): void {
    const arr = this.messages.get(channelId);
    if (!arr) return;
    const idx = arr.findIndex((x) => x.message.id === messageId);
    if (idx !== -1) {
      arr.splice(idx, 1);
      this.emitMessages(channelId);
    }
  }

  private emitChannels(): void {
    const snapshot = this.observeChannels();
    for (const l of this.channelListeners) l(snapshot);
  }
  private emitMessages(channelId: common.ChannelId): void {
    const set = this.messageListeners.get(channelId);
    if (!set) return;
    const snapshot = this.observeMessages(channelId);
    for (const l of set) l(snapshot);
  }
}

export { AppErrorException };
