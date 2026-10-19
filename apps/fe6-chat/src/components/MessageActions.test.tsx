import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { Message } from "../api/contract";
import { MessageItem } from "./MessageItem";
import { MessageActionsContext, type MessageActions } from "./MessageActions";
import { useMessagePrefs } from "../lib/message-prefs";

const ME = "usr_me";
const message: Message = {
  id: "msg_a",
  channelId: "chn",
  authorId: ME,
  body: "hello",
  threadRootId: null,
  replyCount: 0,
  reactions: [],
  attachments: [],
  editedAt: null,
  deletedAt: null,
  version: 1,
  createdAt: "2026-08-09T01:00:00Z",
};

function actions(over: Partial<MessageActions> = {}): MessageActions {
  return {
    isBookmarked: () => false,
    isFollowing: () => false,
    canMarkUnread: () => true,
    markUnread: vi.fn(),
    toggleBookmark: vi.fn(),
    addReminder: vi.fn(),
    copyLink: vi.fn(),
    toggleFollow: vi.fn(),
    copyText: vi.fn(),
    forward: vi.fn(),
    ...over,
  };
}

function renderRow(a: MessageActions, onToggleReaction = vi.fn()) {
  render(
    <MessageActionsContext.Provider value={a}>
      <MessageItem
        message={message}
        currentUserId={ME}
        canModerate={false}
        onToggleReaction={onToggleReaction}
        onReply={vi.fn()}
        onTogglePin={vi.fn()}
        onDelete={vi.fn()}
      />
    </MessageActionsContext.Provider>,
  );
  return onToggleReaction;
}

describe("Slack-style message hover bar", () => {
  beforeEach(() => {
    useMessagePrefs.setState({ userId: "usr_me", reactionUsage: {}, bookmarks: [], reminders: [], follows: [] });
  });

  it("orders the bar as frequent reactions, picker, thread, forward, more", () => {
    renderRow(actions());
    const bar = screen.getByRole("toolbar", { name: "メッセージ操作" });
    const labels = within(bar)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual([
      "👍 を追加",
      "🎉 を追加",
      "✅ を追加",
      "他のリアクションを探す",
      "スレッドで返信する",
      "メッセージを転送する",
      "その他",
    ]);
  });

  it("learns frequent reactions from what the user adds", () => {
    useMessagePrefs.setState({ reactionUsage: { "🔥": 4 } });
    const toggle = renderRow(actions());
    const quick = screen.getAllByTestId("fe6-timeline-quick-reaction");
    expect(quick[0]).toHaveAttribute("aria-label", "🔥 を追加");
    fireEvent.click(quick[1]!);
    expect(toggle).toHaveBeenCalledWith("msg_a", "👍");
    expect(useMessagePrefs.getState().reactionUsage["👍"]).toBe(1);
  });

  it("lists the その他 items in Slack order and runs them", () => {
    const a = actions();
    renderRow(a);
    fireEvent.click(screen.getByTestId("fe6-msg-more"));
    const items = within(screen.getByTestId("fe6-msg-menu"))
      .getAllByRole("menuitem")
      .map((b) => b.textContent);
    expect(items).toEqual([
      "未読にする",
      "ブックマークに追加",
      "リマインダーを追加▸",
      "リンクをコピー",
      "新しい返信の通知を受け取る",
      "メッセージをコピーする",
      "チャンネルへピン留めする",
      "メッセージを編集",
      "メッセージを削除",
    ]);

    fireEvent.click(screen.getByTestId("fe6-msg-reminder"));
    fireEvent.click(screen.getByTestId("fe6-msg-reminder-1h"));
    expect(a.addReminder).toHaveBeenCalledWith(message, "1h");
    expect(screen.queryByTestId("fe6-msg-menu")).toBeNull();

    fireEvent.click(screen.getByTestId("fe6-msg-more"));
    fireEvent.click(screen.getByTestId("fe6-msg-mark-unread"));
    expect(a.markUnread).toHaveBeenCalledWith(message);

    fireEvent.click(screen.getByTestId("fe6-timeline-forward"));
    expect(a.forward).toHaveBeenCalledWith(message);
  });

  it("shows the toggled labels and a bookmark tag", () => {
    renderRow(actions({ isBookmarked: () => true, isFollowing: () => true, canMarkUnread: () => false }));
    expect(screen.getByTestId("fe6-timeline-bookmarked")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("fe6-msg-more"));
    expect(screen.queryByTestId("fe6-msg-mark-unread")).toBeNull();
    expect(screen.getByTestId("fe6-msg-bookmark")).toHaveTextContent("ブックマークから削除");
    expect(screen.getByTestId("fe6-msg-follow")).toHaveTextContent("新しい返信の通知をオフにする");
  });
});
