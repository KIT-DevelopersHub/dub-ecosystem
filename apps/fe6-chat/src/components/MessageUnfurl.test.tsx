import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Message } from "../api/contract";
import type { ChatApiClient } from "../api/client";
import { ChatRuntimeProvider, type ChatRuntime } from "../context";
import {
  MESSAGE_UNFURL_MARKER,
  MessageLookupContext,
  MessageUnfurls,
  ForwardedCard,
  messageLinksIn,
  predecessorId,
  resetMessageUnfurlCache,
  type MessageLookup,
} from "./MessageUnfurl";
import { LinkPreviews, resetLinkPreviewCache } from "./LinkPreview";
import { parseForwardBody } from "../lib/forward";

const ORIGIN = globalThis.location.origin;
const link = (c: string, m: string) => `${ORIGIN}/chat/channels/${c}?message=${m}`;

const msg = (over: Partial<Message> = {}): Message => ({
  id: "msg_0002",
  channelId: "chn_a",
  authorId: "usr_bob",
  body: "会場の下見は 10 時集合です",
  threadRootId: null,
  replyCount: 0,
  reactions: [],
  attachments: [],
  editedAt: null,
  deletedAt: null,
  version: 1,
  createdAt: "2026-10-19T01:00:00Z",
  ...over,
});

function runtime(api: Partial<ChatApiClient>): ChatRuntime {
  return { api: api as ChatApiClient, can: () => true, currentUserId: "usr_me", createRealtimeClient: () => { throw new Error("unused"); } };
}

function lookup(over: Partial<MessageLookup> = {}): MessageLookup {
  return {
    findLoaded: () => undefined,
    resolveUser: (id) => (id === "usr_bob" ? { id, displayName: "Bob", avatarUrl: null } : undefined),
    resolveChannelName: (id) => (id === "chn_a" ? "#general" : undefined),
    onOpen: vi.fn(),
    ...over,
  };
}

describe("message link unfurl", () => {
  beforeEach(() => {
    resetMessageUnfurlCache();
    resetLinkPreviewCache();
  });

  it("finds this app's message links (max 2, never the message itself)", () => {
    const body = `${link("chn_a", "m1")} ${link("chn_a", "self")} https://github.com/x ${link("chn_b", "m2")} ${link("chn_c", "m3")}`;
    expect(messageLinksIn(body, ORIGIN, "self" as Message["id"]).map((l) => l.link.messageId)).toEqual(["m1", "m2"]);
    expect(predecessorId("01B")).toBe("01A");
  });

  it("renders an already loaded message as a quote card that jumps on click", () => {
    const l = lookup({ findLoaded: (id) => (id === "msg_0002" ? msg() : undefined) });
    render(
      <MessageLookupContext.Provider value={l}>
        <MessageUnfurls body={`見て ${link("chn_a", "msg_0002")}`} />
      </MessageLookupContext.Provider>,
    );
    const card = screen.getByTestId("fe6-msg-unfurl");
    expect(card).toHaveAttribute("data-marker", MESSAGE_UNFURL_MARKER);
    expect(card).toHaveTextContent("Bob");
    expect(card).toHaveTextContent("会場の下見は 10 時集合です");
    expect(card).toHaveTextContent("#general に投稿");
    fireEvent.click(screen.getByTestId("fe6-msg-unfurl-open"));
    expect(l.onOpen).toHaveBeenCalledWith({ channelId: "chn_a", messageId: "msg_0002", threadRootId: null });
  });

  it("fetches a message that is not loaded (skeleton first) via listMessages", async () => {
    const listMessages = vi.fn().mockResolvedValue({ items: [msg({ id: "msg_0001" }), msg()], nextCursor: null });
    render(
      <ChatRuntimeProvider value={runtime({ listMessages, resolveUsers: vi.fn().mockResolvedValue([]) })}>
        <MessageLookupContext.Provider value={lookup()}>
          <MessageUnfurls body={link("chn_a", "msg_0002")} />
        </MessageLookupContext.Provider>
      </ChatRuntimeProvider>,
    );
    expect(screen.getByTestId("fe6-msg-unfurl-loading")).toBeInTheDocument();
    expect(await screen.findByTestId("fe6-msg-unfurl")).toHaveTextContent("会場の下見");
    expect(listMessages).toHaveBeenCalledWith({ channelId: "chn_a", afterMessageId: "msg_0001", limit: 5 });
  });

  it("shows a quiet card when the message can't be read or was deleted", async () => {
    const listMessages = vi.fn().mockRejectedValue(new Error("404"));
    const { unmount } = render(
      <ChatRuntimeProvider value={runtime({ listMessages })}>
        <MessageUnfurls body={link("chn_x", "msg_9")} />
      </ChatRuntimeProvider>,
    );
    expect(await screen.findByTestId("fe6-msg-unfurl-unavailable")).toHaveTextContent("メッセージを表示できません");
    unmount();
    render(
      <MessageLookupContext.Provider value={lookup({ findLoaded: () => msg({ deletedAt: "2026-10-19T02:00:00Z" }) })}>
        <MessageUnfurls body={link("chn_a", "msg_0002")} />
      </MessageLookupContext.Provider>,
    );
    expect(screen.getByTestId("fe6-msg-unfurl-unavailable")).toHaveTextContent("このメッセージは削除されました");
  });

  it("does not ask the OGP unfurler for a message link", async () => {
    const unfurl = vi.fn().mockResolvedValue(null);
    render(
      <ChatRuntimeProvider value={runtime({ unfurl })}>
        <LinkPreviews body={`${link("chn_a", "m1")} https://github.com/x`} />
      </ChatRuntimeProvider>,
    );
    await vi.waitFor(() => expect(unfurl).toHaveBeenCalled());
    expect(unfurl.mock.calls.map((c) => c[0])).toEqual(["https://github.com/x"]);
  });

  it("draws a forwarded post as the same card", () => {
    const fwd = parseForwardBody(`> こんにちは\n> — Bob · #general から転送 ${link("chn_a", "msg_0002")}`)!;
    const l = lookup();
    render(
      <MessageLookupContext.Provider value={l}>
        <ForwardedCard forward={fwd} />
      </MessageLookupContext.Provider>,
    );
    const card = screen.getByTestId("fe6-msg-forwarded");
    expect(card).toHaveTextContent("Bob");
    expect(card).toHaveTextContent("こんにちは");
    expect(card).toHaveTextContent("#general から転送");
    fireEvent.click(card);
    expect(l.onOpen).toHaveBeenCalled();
  });
});
