import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ToastProvider } from "@dub/ui";
import type { ChatApiClient } from "../api/client";
import { ChatRuntimeProvider, type ChatRuntime } from "../context";
import { useMessagePrefs } from "../lib/message-prefs";
import { LATER_MARKER, LaterView } from "./LaterView";
import { ChannelList } from "./ChannelList";

const ref = (id: string, over = {}) => ({ messageId: id, channelId: "chn_a", authorId: "usr_bob", excerpt: `本文 ${id}`, ...over });

function setup() {
  const onOpen = vi.fn();
  const api = { resolveUsers: vi.fn().mockResolvedValue([{ id: "usr_bob", displayName: "Bob", avatarUrl: null }]) };
  const rt: ChatRuntime = { api: api as unknown as ChatApiClient, can: () => true, currentUserId: "usr_me", createRealtimeClient: () => { throw new Error("unused"); } };
  render(
    <ChatRuntimeProvider value={rt}>
      <ToastProvider>
        <LaterView resolveChannelName={(id) => (id === "chn_a" ? "#general" : undefined)} onOpen={onOpen} />
      </ToastProvider>
    </ChatRuntimeProvider>,
  );
  return { onOpen };
}

describe("後で (Slack Later)", () => {
  beforeEach(() => {
    localStorage.clear();
    useMessagePrefs.setState({ userId: null, reactionUsage: {}, bookmarks: [], reminders: [], follows: [], completed: [] });
    useMessagePrefs.getState().hydrate("usr_me");
    useMessagePrefs.getState().toggleBookmark(ref("m1"));
    useMessagePrefs.getState().addReminder(ref("m2"), new Date("2099-01-01T00:00:00Z"));
  });

  it("lists saved items with author (skeleton until resolved) and channel, opening on click", async () => {
    const { onOpen } = setup();
    expect(screen.getByTestId("fe6-later-view")).toHaveAttribute("data-marker", LATER_MARKER);
    const row = screen.getByTestId("fe6-later-row");
    expect(row).toHaveTextContent("#general");
    expect(row).toHaveTextContent("本文 m1");
    expect(await within(row).findByText("Bob")).toBeInTheDocument();
    fireEvent.click(within(row).getByTestId("fe6-later-open"));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ messageId: "m1", channelId: "chn_a" }));
  });

  it("completes, restores and unsaves", async () => {
    setup();
    await screen.findByText("Bob");
    fireEvent.click(screen.getByTestId("fe6-later-complete"));
    expect(screen.getByTestId("fe6-later-empty")).toHaveTextContent("保存済みのアイテムはありません");
    fireEvent.click(screen.getByRole("tab", { name: "完了" }));
    expect(screen.getByTestId("fe6-later-row")).toHaveTextContent("本文 m1");
    fireEvent.click(screen.getByTestId("fe6-later-restore"));
    expect(useMessagePrefs.getState().bookmarks.map((b) => b.messageId)).toEqual(["m1"]);
    fireEvent.click(screen.getByRole("tab", { name: /保存済み/ }));
    fireEvent.click(screen.getByTestId("fe6-later-unsave"));
    expect(useMessagePrefs.getState().bookmarks).toEqual([]);
  });

  it("shows reminders by due time and deletes one", async () => {
    setup();
    await screen.findByText("Bob");
    fireEvent.click(screen.getByRole("tab", { name: /リマインダー/ }));
    const row = screen.getByTestId("fe6-later-row");
    expect(row).toHaveTextContent("本文 m2");
    expect(row).toHaveTextContent("⏰");
    fireEvent.click(screen.getByTestId("fe6-later-remove-reminder"));
    expect(useMessagePrefs.getState().reminders).toEqual([]);
  });
});

describe("sidebar 後で entry", () => {
  it("sits above the channels with a count badge", () => {
    const onOpen = vi.fn();
    render(
      <ChannelList channels={[]} unread={{}} activeChannelId={null} canCreate={false} onSelect={() => {}} later={{ count: 3, active: true, onOpen }} />,
    );
    const item = screen.getByTestId("fe6-sidebar-later");
    expect(item).toHaveAttribute("aria-current", "page");
    expect(item).toHaveAttribute("data-marker", "fe6-later-sidebar");
    expect(screen.getByTestId("fe6-sidebar-later-count")).toHaveTextContent("3");
    fireEvent.click(item);
    expect(onOpen).toHaveBeenCalled();
  });
});
