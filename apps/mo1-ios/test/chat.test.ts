import { describe, it, expect } from "vitest";
import type { chat } from "@dub/types";
import {
  ChatSession,
  appendOptimistic,
  applyRealtimeEvent,
  chatSocketUrl,
  emptyChannel,
  loadHistory,
  markFailed,
  stubChatSocket,
} from "../src/chat.js";
import { MobileApiClient } from "../src/api-client.js";
import { InMemoryTokenStore } from "../src/token-store.js";
import { ok, scriptedTransport } from "./helpers.js";

const BASE = "https://m-api.developershub.jp";
const CH = "chan_1";
const noSleep = async (): Promise<void> => {};

function created(over: Partial<Extract<chat.ChatRealtimeEvent, { kind: "message.created" }>> = {}): chat.ChatRealtimeEvent {
  return {
    kind: "message.created",
    channelId: CH,
    messageId: "msg_srv",
    authorId: "me",
    body: "hello",
    at: "2026-08-09T00:00:01Z",
    ...over,
  };
}

function seededStore(): InMemoryTokenStore {
  const store = new InMemoryTokenStore();
  store.write({ token: "tok", sessionExpiresAt: Date.now() + 3_600_000 });
  return store;
}

describe("chat reducers (楽観追記 / RT reconcile)", () => {
  it("loadHistory sorts by time, marks sent, and dedupes by id", () => {
    const history: chat.ChatMessage[] = [
      { id: "m2", channelId: CH, authorId: "u1", body: "b", createdAt: "2026-08-09T00:00:02Z" },
      { id: "m1", channelId: CH, authorId: "u1", body: "a", createdAt: "2026-08-09T00:00:01Z" },
    ];
    const s1 = loadHistory(emptyChannel(CH), history);
    expect(s1.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(s1.messages.every((m) => m.status === "sent")).toBe(true);
    // re-applying the same history is idempotent
    expect(loadHistory(s1, history).messages).toHaveLength(2);
  });

  it("appendOptimistic shows the message as pending immediately", () => {
    const s = appendOptimistic(emptyChannel(CH), {
      localId: "loc_1",
      authorId: "me",
      body: "hi",
      createdAt: "2026-08-09T00:00:00Z",
    });
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ id: "loc_1", localId: "loc_1", status: "pending", body: "hi" });
  });

  it("message.created reconciles the matching pending message to sent", () => {
    let s = appendOptimistic(emptyChannel(CH), {
      localId: "loc_1",
      authorId: "me",
      body: "hello",
      createdAt: "2026-08-09T00:00:00Z",
    });
    s = applyRealtimeEvent(s, created({ messageId: "msg_srv", body: "hello" }));
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ id: "msg_srv", status: "sent" });
    expect(s.messages[0]!.localId).toBeUndefined();
  });

  it("message.created from another author appends a new sent message", () => {
    const s = applyRealtimeEvent(emptyChannel(CH), created({ messageId: "m_x", authorId: "other", body: "yo" }));
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ id: "m_x", authorId: "other", status: "sent" });
  });

  it("message.created is idempotent by messageId (reconnect re-delivery)", () => {
    let s = applyRealtimeEvent(emptyChannel(CH), created({ messageId: "dup" }));
    s = applyRealtimeEvent(s, created({ messageId: "dup" }));
    expect(s.messages).toHaveLength(1);
  });

  it("message.deleted removes the message", () => {
    let s = applyRealtimeEvent(emptyChannel(CH), created({ messageId: "gone", authorId: "u9" }));
    s = applyRealtimeEvent(s, { kind: "message.deleted", channelId: CH, messageId: "gone", at: "2026-08-09T00:00:05Z" });
    expect(s.messages).toHaveLength(0);
  });

  it("ignores events for a different channel and member events", () => {
    const base = appendOptimistic(emptyChannel(CH), { localId: "l", authorId: "me", body: "x", createdAt: "2026-08-09T00:00:00Z" });
    expect(applyRealtimeEvent(base, created({ channelId: "other" }))).toBe(base);
    expect(applyRealtimeEvent(base, { kind: "member.added", channelId: CH, userId: "u2", at: "2026-08-09T00:00:00Z" })).toBe(base);
  });

  it("markFailed flips a pending message and no-ops otherwise", () => {
    const s = appendOptimistic(emptyChannel(CH), { localId: "l", authorId: "me", body: "x", createdAt: "2026-08-09T00:00:00Z" });
    expect(markFailed(s, "l").messages[0]!.status).toBe("failed");
    expect(markFailed(s, "missing")).toBe(s);
  });
});

describe("chatSocketUrl", () => {
  it("appends the ticket to the DO-direct url", () => {
    const url = chatSocketUrl({ ticket: "tkt", doUrl: "wss://do.example/room/1", expiresAt: "2026-08-09T00:10:00Z" });
    expect(new URL(url).searchParams.get("ticket")).toBe("tkt");
  });
});

describe("ChatSession over an injected WS stub", () => {
  const ticket: chat.WsTicketResponse = { ticket: "tkt", doUrl: "wss://do.example/room/1", expiresAt: "2026-08-09T00:10:00Z" };

  it("send appends optimistically, transmits a frame, and RT echo confirms it", () => {
    const factory = stubChatSocket();
    const changes: number[] = [];
    let seq = 0;
    const session = new ChatSession({
      channelId: CH,
      selfId: "me",
      factory,
      onChange: (st) => changes.push(st.messages.length),
      newLocalId: () => `loc_${seq++}`,
      now: () => Date.parse("2026-08-09T00:00:00Z"),
    });
    session.connect(ticket);

    const localId = session.send("hello");
    expect(localId).toBe("loc_0");
    expect(factory.socket!.url).toContain("ticket=tkt");
    expect(factory.socket!.sent).toEqual([{ kind: "message.send", localId: "loc_0", body: "hello" }]);
    expect(session.state.messages[0]!.status).toBe("pending");

    factory.socket!.emit(created({ messageId: "msg_srv", authorId: "me", body: "hello" }));
    expect(session.state.messages).toHaveLength(1);
    expect(session.state.messages[0]).toMatchObject({ id: "msg_srv", status: "sent" });
    expect(changes.length).toBeGreaterThanOrEqual(2);
  });

  it("marks the message failed when the socket is not connected", () => {
    const factory = stubChatSocket();
    const session = new ChatSession({ channelId: CH, selfId: "me", factory, newLocalId: () => "loc" });
    const localId = session.send("orphan"); // no connect() first
    expect(localId).toBe("loc");
    expect(session.state.messages[0]!.status).toBe("failed");
  });

  it("close() shuts the socket", () => {
    const factory = stubChatSocket();
    const session = new ChatSession({ channelId: CH, selfId: "me", factory });
    session.connect(ticket);
    session.close();
    expect(factory.socket!.closed).toBe(true);
  });
});

describe("MobileApiClient chat reads (/m/v1/chat/*)", () => {
  it("lists channels and messages and fetches a WS ticket", async () => {
    const store = seededStore();
    const { transport, calls } = scriptedTransport([
      ok({ items: [{ id: CH, name: "general", createdAt: "2026-08-09T00:00:00Z" }], nextCursor: null }),
      ok({ items: [], nextCursor: "c2" }),
      ok({ ticket: "tkt", doUrl: "wss://do.example/room/1", expiresAt: "2026-08-09T00:10:00Z" }),
    ]);
    const client = new MobileApiClient({ baseUrl: BASE, transport, tokenStore: store, sleep: noSleep });

    const channels = await client.listChatChannels();
    expect(new URL(calls[0]!.url).pathname).toBe("/m/v1/chat/channels");
    expect(channels.items[0]!.id).toBe(CH);

    const msgs = await client.listChatMessages(CH, { limit: 30 });
    const mUrl = new URL(calls[1]!.url);
    expect(mUrl.pathname).toBe(`/m/v1/chat/channels/${CH}/messages`);
    expect(mUrl.searchParams.get("limit")).toBe("30");
    expect(msgs.nextCursor).toBe("c2");

    const ticket = await client.getChatWsTicket(CH);
    expect(new URL(calls[2]!.url).pathname).toBe(`/m/v1/chat/channels/${CH}/ws-ticket`);
    expect(ticket.ticket).toBe("tkt");
  });
});
