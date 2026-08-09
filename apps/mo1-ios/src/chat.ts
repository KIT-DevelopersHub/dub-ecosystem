// chat — ChatView (S8) channel/message view-model + optimistic append over the
// frozen `chat` namespace (design §2-1 S8; RT土台 = Durable Objects, WS is
// DO-direct / gateway-bypassing). Two responsibilities:
//   1. 楽観追記 — the user's message shows immediately (status "pending"); the
//      echoed `message.created` RT event reconciles it to "sent" (or markFailed
//      flips it to "failed"). Reconnect re-delivery is idempotent by messageId.
//   2. WS transport injection — the DO WebSocket can't run in vitest, so it sits
//      behind a `ChatSocketFactory` interface; `stubChatSocket()` drives it in
//      tests exactly like the Swift URLSessionWebSocketTask stub.
// The reducers are pure so the Swift ChatViewModel and its tests share one impl.
import type { chat } from "@dub/types";

type ChannelId = string;
type MessageId = string;
type UserId = string;
type ISODateTime = string;

// ---- view-model ------------------------------------------------------------

export type ChatMessageStatus = "pending" | "sent" | "failed";

export interface ChatMessageVM {
  /** server MessageId once confirmed; the local id while still "pending". */
  id: MessageId;
  channelId: ChannelId;
  authorId: UserId;
  body: string;
  createdAt: ISODateTime;
  status: ChatMessageStatus;
  /** local correlation id for an optimistic message (dropped once confirmed). */
  localId?: string;
}

export interface ChatChannelState {
  channelId: ChannelId;
  /** chronological, oldest -> newest. */
  messages: ChatMessageVM[];
}

export function emptyChannel(channelId: ChannelId): ChatChannelState {
  return { channelId, messages: [] };
}

function sorted(messages: ChatMessageVM[]): ChatMessageVM[] {
  // Stable sort by createdAt; ties keep insertion order (Array.sort is stable).
  return [...messages].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** Seed / merge server history (`GET messages`). Server ids win over dupes. */
export function loadHistory(state: ChatChannelState, history: readonly chat.ChatMessage[]): ChatChannelState {
  const seen = new Set(state.messages.map((m) => m.id));
  const merged = [...state.messages];
  for (const m of history) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    merged.push({
      id: m.id,
      channelId: m.channelId,
      authorId: m.authorId,
      body: m.body,
      createdAt: m.createdAt,
      status: "sent",
    });
  }
  return { channelId: state.channelId, messages: sorted(merged) };
}

export interface OptimisticSend {
  localId: string;
  authorId: UserId;
  body: string;
  createdAt: ISODateTime;
}

/** Append the user's just-sent message as "pending" (optimistic). */
export function appendOptimistic(state: ChatChannelState, send: OptimisticSend): ChatChannelState {
  const msg: ChatMessageVM = {
    id: send.localId,
    channelId: state.channelId,
    authorId: send.authorId,
    body: send.body,
    createdAt: send.createdAt,
    status: "pending",
    localId: send.localId,
  };
  return { channelId: state.channelId, messages: sorted([...state.messages, msg]) };
}

/** Flip a still-pending optimistic message to "failed" (send error / timeout). */
export function markFailed(state: ChatChannelState, localId: string): ChatChannelState {
  let changed = false;
  const messages = state.messages.map((m) => {
    if (m.localId === localId && m.status === "pending") {
      changed = true;
      return { ...m, status: "failed" as const };
    }
    return m;
  });
  return changed ? { channelId: state.channelId, messages } : state;
}

/**
 * Fold a frozen RT event into the channel:
 * - message.created: confirm the matching pending optimistic message (same
 *   author + body), else append it as a new "sent" message. Idempotent by
 *   messageId so WS reconnect re-delivery is a no-op.
 * - message.deleted: drop the message (by id).
 * - member.added / member.removed: no message-list change (returned as-is).
 */
export function applyRealtimeEvent(state: ChatChannelState, ev: chat.ChatRealtimeEvent): ChatChannelState {
  if (ev.channelId !== state.channelId) return state;

  switch (ev.kind) {
    case "message.created": {
      if (state.messages.some((m) => m.id === ev.messageId)) return state; // already have it
      const pendingIdx = state.messages.findIndex(
        (m) => m.status === "pending" && m.authorId === ev.authorId && m.body === ev.body,
      );
      if (pendingIdx >= 0) {
        const messages = state.messages.map((m, i) =>
          i === pendingIdx
            ? { ...m, id: ev.messageId, createdAt: ev.at, status: "sent" as const, localId: undefined }
            : m,
        );
        return { channelId: state.channelId, messages: sorted(messages) };
      }
      const created: ChatMessageVM = {
        id: ev.messageId,
        channelId: ev.channelId,
        authorId: ev.authorId,
        body: ev.body,
        createdAt: ev.at,
        status: "sent",
      };
      return { channelId: state.channelId, messages: sorted([...state.messages, created]) };
    }
    case "message.deleted": {
      const messages = state.messages.filter((m) => m.id !== ev.messageId);
      return messages.length === state.messages.length ? state : { channelId: state.channelId, messages };
    }
    case "member.added":
    case "member.removed":
      return state;
  }
}

// ---- WS transport (injected; DO-direct, gateway-bypassing) -----------------

export interface ChatSocketHandlers {
  onEvent: (ev: chat.ChatRealtimeEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (cause: unknown) => void;
}

/** Live socket handle (mirrors Swift URLSessionWebSocketTask). */
export interface ChatSocket {
  send(frame: ChatSendFrame): void;
  close(): void;
}

/** Injected factory: opens a DO-direct socket for one ticket. */
export interface ChatSocketFactory {
  connect(url: string, handlers: ChatSocketHandlers): ChatSocket;
}

/**
 * Outbound client -> ChatRoom-DO frame. The frozen `chat` namespace publishes
 * the inbound `ChatRealtimeEvent` wire contract but NOT the outbound send frame
 * (message CRUD is STUB pending 9-C), so this is a client-local placeholder —
 * replace with the generated type once chat-service freezes it (README gap).
 */
export interface ChatSendFrame {
  kind: "message.send";
  localId: string;
  body: string;
}

/** Append the DO ticket to the DO-direct URL the socket connects to. */
export function chatSocketUrl(ticket: chat.WsTicketResponse): string {
  const u = new URL(ticket.doUrl);
  u.searchParams.set("ticket", ticket.ticket);
  return u.toString();
}

/**
 * ChatSession ties the injected socket to the optimistic reducer: incoming RT
 * events reconcile state, `send()` appends optimistically then transmits. All
 * state changes surface through `onChange` (the SwiftUI @Published mirror).
 */
export class ChatSession {
  readonly #channelId: ChannelId;
  readonly #selfId: UserId;
  readonly #factory: ChatSocketFactory;
  readonly #onChange?: (state: ChatChannelState) => void;
  readonly #newLocalId: () => string;
  readonly #now: () => number;
  #state: ChatChannelState;
  #socket: ChatSocket | null = null;

  constructor(opts: {
    channelId: ChannelId;
    selfId: UserId;
    factory: ChatSocketFactory;
    onChange?: (state: ChatChannelState) => void;
    newLocalId?: () => string;
    now?: () => number;
  }) {
    this.#channelId = opts.channelId;
    this.#selfId = opts.selfId;
    this.#factory = opts.factory;
    this.#onChange = opts.onChange;
    this.#now = opts.now ?? Date.now;
    let seq = 0;
    this.#newLocalId = opts.newLocalId ?? (() => `local_${this.#now()}_${seq++}`);
    this.#state = emptyChannel(opts.channelId);
  }

  get state(): ChatChannelState {
    return this.#state;
  }

  /** Merge server history into the channel (call before/after connect). */
  loadHistory(history: readonly chat.ChatMessage[]): void {
    this.#commit(loadHistory(this.#state, history));
  }

  /** Open the DO-direct socket for a fetched ticket. */
  connect(ticket: chat.WsTicketResponse): void {
    this.#socket = this.#factory.connect(chatSocketUrl(ticket), {
      onEvent: (ev) => this.#commit(applyRealtimeEvent(this.#state, ev)),
      onOpen: undefined,
      onClose: undefined,
    });
  }

  /** Optimistically append the message and transmit it; returns its localId. */
  send(body: string): string {
    const localId = this.#newLocalId();
    const createdAt = new Date(this.#now()).toISOString();
    this.#commit(appendOptimistic(this.#state, { localId, authorId: this.#selfId, body, createdAt }));
    try {
      if (this.#socket === null) throw new Error("chat socket not connected");
      this.#socket.send({ kind: "message.send", localId, body });
    } catch {
      this.#commit(markFailed(this.#state, localId));
    }
    return localId;
  }

  close(): void {
    this.#socket?.close();
    this.#socket = null;
  }

  #commit(next: ChatChannelState): void {
    if (next === this.#state) return;
    this.#state = next;
    this.#onChange?.(next);
  }
}

// ---- test / preview stub ----------------------------------------------------

export interface StubChatSocket extends ChatSocket {
  /** frames the client transmitted (assert outbound wire in tests). */
  readonly sent: ChatSendFrame[];
  /** push a server RT event down to the session. */
  emit(ev: chat.ChatRealtimeEvent): void;
  readonly closed: boolean;
  readonly url: string;
}

export interface StubChatFactory extends ChatSocketFactory {
  /** the socket from the most recent connect() (null before first connect). */
  readonly socket: StubChatSocket | null;
}

/** In-memory ChatSocketFactory for tests/previews (no real WebSocket). */
export function stubChatSocket(): StubChatFactory {
  let socket: StubChatSocket | null = null;
  return {
    get socket() {
      return socket;
    },
    connect(url, handlers) {
      const sent: ChatSendFrame[] = [];
      let closed = false;
      const s: StubChatSocket = {
        url,
        sent,
        get closed() {
          return closed;
        },
        send(frame) {
          if (closed) throw new Error("socket closed");
          sent.push(frame);
        },
        emit(ev) {
          handlers.onEvent(ev);
        },
        close() {
          closed = true;
          handlers.onClose?.();
        },
      };
      socket = s;
      handlers.onOpen?.();
      return s;
    },
  };
}
