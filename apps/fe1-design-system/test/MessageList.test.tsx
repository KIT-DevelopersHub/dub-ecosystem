import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageList } from "../src/components/MessageList";
import type { ChatMessage } from "../src/types";

const messages: ChatMessage[] = [
  { id: "m1", authorName: "Ada", body: "hello", timeLabel: "09:00", dayKey: "2026-01-01" },
  { id: "m2", authorName: "Bob", body: "hi", timeLabel: "09:01", dayKey: "2026-01-01", reactions: [{ emoji: "👍", count: 2, mine: true }] },
  { id: "m3", authorName: "Ada", body: "gone", timeLabel: "10:00", dayKey: "2026-01-02", deleted: true },
];

describe("MessageList", () => {
  it("renders each message body and forwards testId", () => {
    render(<MessageList messages={messages} testId="ml" />);
    expect(screen.getByTestId("ml")).toBeInTheDocument();
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByText("hi")).toBeInTheDocument();
  });

  it("inserts a day divider only when dayKey changes", () => {
    render(<MessageList messages={messages} testId="ml" />);
    const dividers = screen.getAllByTestId("ml-day-divider");
    expect(dividers).toHaveLength(2); // first day + the Jan-02 change
    expect(dividers[1]).toHaveTextContent("2026-01-02");
  });

  it("renders a tombstone for deleted messages instead of the body", () => {
    render(<MessageList messages={messages} testId="ml" />);
    expect(screen.getByTestId("ml-deleted")).toHaveTextContent("削除されました");
    expect(screen.queryByText("gone")).toBeNull();
  });

  it("renders the unread divider before the flagged message", () => {
    render(<MessageList messages={messages} unreadBeforeId="m2" testId="ml" />);
    expect(screen.getByTestId("ml-unread-divider")).toHaveTextContent("ここから未読");
  });

  it("toggles a reaction", async () => {
    const onToggleReaction = vi.fn();
    render(<MessageList messages={messages} onToggleReaction={onToggleReaction} testId="ml" />);
    await userEvent.click(screen.getByTestId("ml-reaction"));
    expect(onToggleReaction).toHaveBeenCalledWith("m2", "👍");
  });

  it("shows load-older affordance and fires it", async () => {
    const onLoadOlder = vi.fn();
    render(<MessageList messages={messages} hasOlder onLoadOlder={onLoadOlder} testId="ml" />);
    await userEvent.click(screen.getByTestId("ml-load-older"));
    expect(onLoadOlder).toHaveBeenCalledOnce();
  });

  it("renders failed-send state with injected retry actions", () => {
    const failed: ChatMessage[] = [{ id: "p1", authorName: "Me", body: "oops", timeLabel: "", state: "failed" }];
    render(
      <MessageList
        messages={failed}
        renderFailedActions={() => <button data-testid="ml-resend">再送</button>}
        testId="ml"
      />,
    );
    const row = screen.getByTestId("ml-message");
    expect(row).toHaveAttribute("data-state", "failed");
    expect(screen.getByTestId("ml-resend")).toBeInTheDocument();
    expect(screen.getByText("送信に失敗しました")).toBeInTheDocument();
  });

  it("injects auth-gated actions via renderActions on non-deleted messages", () => {
    render(
      <MessageList
        messages={messages}
        renderActions={(m) => <button data-testid={`ml-edit-${m.id}`}>編集</button>}
        testId="ml"
      />,
    );
    expect(screen.getByTestId("ml-edit-m1")).toBeInTheDocument();
    expect(screen.queryByTestId("ml-edit-m3")).toBeNull(); // deleted → no actions
  });

  it("renders the empty state when there are no messages", () => {
    render(<MessageList messages={[]} emptyState="メッセージなし" testId="ml" />);
    expect(screen.getByText("メッセージなし")).toBeInTheDocument();
  });
});
