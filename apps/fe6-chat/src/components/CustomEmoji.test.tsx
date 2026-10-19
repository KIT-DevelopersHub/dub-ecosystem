import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Message } from "../api/contract";
import { MockChatClient } from "../api/mock-client";
import { CustomEmojiProvider } from "./CustomEmoji";
import { MessageItem } from "./MessageItem";

const ME = "usr_me";
function msg(reactions: Message["reactions"]): Message {
  return {
    id: "msg_a",
    channelId: "chn",
    authorId: "usr_other",
    body: "hello",
    threadRootId: null,
    replyCount: 0,
    reactions,
    attachments: [],
    editedAt: null,
    deletedAt: null,
    version: 1,
    createdAt: "2026-08-09T01:00:00Z",
  };
}

let seq = 0;
beforeEach(() => {
  seq = 0;
  // jsdom has no object URLs; the provider turns each image Blob into one.
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = vi.fn(() => `blob:emoji-${++seq}`);
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = vi.fn();
});
afterEach(() => vi.restoreAllMocks());

function renderItem(message: Message, onToggleReaction = vi.fn(), api = new MockChatClient({ currentUserId: ME })) {
  render(
    <CustomEmojiProvider api={api}>
      <MessageItem message={message} currentUserId={ME} canModerate={false} onToggleReaction={onToggleReaction} />
    </CustomEmojiProvider>,
  );
  return { onToggleReaction, api };
}

describe("reaction chips with custom emoji", () => {
  it("renders a known :name: as an image (same chip, count kept) and an unknown one as text", async () => {
    renderItem(msg([
      { emoji: ":kit-dev:", userIds: ["usr_other", ME] },
      { emoji: ":nope:", userIds: [ME] },
      { emoji: "👍", userIds: [ME] },
    ]));
    const img = await screen.findByTestId("fe6-custom-emoji");
    expect(img).toHaveAttribute("alt", ":kit-dev:");
    expect(img).toHaveAttribute("title", ":kit-dev:");
    expect(img.getAttribute("src")).toMatch(/^blob:emoji-/);
    const chips = screen.getAllByTestId("fe6-timeline-reaction");
    expect(chips[0]).toHaveTextContent("2");
    expect(chips[1]).toHaveTextContent(":nope:");
    expect(chips[2]).toHaveTextContent("👍");
  });

  it("holds a skeleton slot while the emoji list is loading", async () => {
    const api = new MockChatClient({ currentUserId: ME });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const list = api.listCustomEmojis.bind(api);
    api.listCustomEmojis = async () => (await gate, list());
    renderItem(msg([{ emoji: ":kit-dev:", userIds: [ME] }]), vi.fn(), api);
    expect(screen.getByTestId("fe6-custom-emoji-loading")).toBeInTheDocument();
    await act(async () => release());
    expect(await screen.findByTestId("fe6-custom-emoji")).toBeInTheDocument();
  });

  it("falls back to text when the image cannot be loaded", async () => {
    const api = new MockChatClient({ currentUserId: ME });
    api.customEmojiImage = () => Promise.reject(new Error("net"));
    renderItem(msg([{ emoji: ":kit-dev:", userIds: [ME] }]), vi.fn(), api);
    expect(await screen.findByText(":kit-dev:")).toBeInTheDocument();
    expect(screen.queryByTestId("fe6-custom-emoji")).toBeNull();
  });
});

describe("EmojiPicker カスタム tab", () => {
  it("lists custom emoji, filters by name, and reacts with :name:", async () => {
    const user = userEvent.setup();
    const { onToggleReaction } = renderItem(msg([{ emoji: "👍", userIds: [ME] }]));
    await user.click(screen.getByTestId("fe6-timeline-add-reaction"));
    await user.click(screen.getByTestId("fe6-emoji-tab-custom"));
    const tab = await screen.findByTestId("fe6-emoji-custom");
    expect(tab).toHaveAttribute("data-feature", "custom-emoji-v1");
    expect(within(tab).getAllByTestId("fe6-emoji-custom-option").map((b) => b.getAttribute("aria-label"))).toEqual([":devhub:", ":kit-dev:"]);
    await user.type(screen.getByTestId("fe6-emoji-custom-search"), "kit");
    const options = within(tab).getAllByTestId("fe6-emoji-custom-option");
    expect(options).toHaveLength(1);
    await user.click(options[0]!);
    expect(onToggleReaction).toHaveBeenCalledWith("msg_a", ":kit-dev:");
    expect(screen.queryByTestId("fe6-emoji-panel")).toBeNull();
  });

  it("offers the import entry only when the provider allows importing", async () => {
    const user = userEvent.setup();
    const onOpenImport = vi.fn();
    render(
      <CustomEmojiProvider api={new MockChatClient({ currentUserId: ME })} onOpenImport={onOpenImport}>
        <MessageItem message={msg([{ emoji: "👍", userIds: [ME] }])} currentUserId={ME} canModerate={false} />
      </CustomEmojiProvider>,
    );
    await user.click(screen.getByTestId("fe6-timeline-add-reaction"));
    await user.click(screen.getByTestId("fe6-emoji-tab-custom"));
    await user.click(await screen.findByTestId("fe6-emoji-import-open"));
    expect(onOpenImport).toHaveBeenCalled();
  });

  it("hides an empty カスタム tab from someone who cannot import (no dead end)", async () => {
    const user = userEvent.setup();
    const api = new MockChatClient({ currentUserId: ME });
    api.listCustomEmojis = async () => [];
    render(
      <CustomEmojiProvider api={api}>
        <MessageItem message={msg([{ emoji: "👍", userIds: [ME] }])} currentUserId={ME} canModerate={false} />
      </CustomEmojiProvider>,
    );
    await act(async () => undefined);
    await user.click(screen.getByTestId("fe6-timeline-add-reaction"));
    expect(screen.queryByTestId("fe6-emoji-tab-custom")).toBeNull();
  });

  it("has no カスタム tab outside a provider (plain curated grid)", async () => {
    const user = userEvent.setup();
    render(<MessageItem message={msg([{ emoji: "👍", userIds: [ME] }])} currentUserId={ME} canModerate={false} />);
    await user.click(screen.getByTestId("fe6-timeline-add-reaction"));
    expect(screen.queryByTestId("fe6-emoji-tab-custom")).toBeNull();
    expect(screen.getByRole("button", { name: "🎉" })).toBeInTheDocument();
  });
});
