import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NotificationInboxPage } from "../src/components/NotificationInboxPage";
import { MockApiError } from "../src/api/mock-client";
import { useUnreadStore } from "../src/store/unread-store";
import { makeDeps, renderWithDeps } from "./helpers";

describe("NotificationInboxPage", () => {
  it("renders the seeded inbox with unread dots (test 1)", async () => {
    const { deps } = makeDeps();
    renderWithDeps(<NotificationInboxPage initialFilter={{ unreadOnly: false, category: "all", type: "" }} />, deps);
    await screen.findByTestId("fe5-inbox-list");
    expect(screen.getByTestId("fe5-inbox-item-notif_0001")).toHaveAttribute("data-unread", "true");
    // seed has 3 unread items -> 3 dots
    expect(screen.getAllByTestId("fe5-inbox-unread-dot")).toHaveLength(3);
  });

  it("LoadMore appends the next page and stops at the end (test 2)", async () => {
    const { deps } = makeDeps();
    renderWithDeps(
      <NotificationInboxPage initialFilter={{ unreadOnly: false, category: "all", type: "" }} pageSize={2} />,
      deps,
    );
    await screen.findByTestId("fe5-inbox-list");
    let rows = within(screen.getByTestId("fe5-inbox-list")).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("fe5-inbox-loadmore"));
    await waitFor(() => {
      rows = within(screen.getByTestId("fe5-inbox-list")).getAllByRole("listitem");
      expect(rows).toHaveLength(4);
    });
  });

  it("unread-only filter refetches and syncs the URL (test 3)", async () => {
    const { deps } = makeDeps();
    renderWithDeps(<NotificationInboxPage initialFilter={{ unreadOnly: false, category: "all", type: "" }} />, deps);
    await screen.findByTestId("fe5-inbox-list");
    const user = userEvent.setup();
    await user.click(screen.getByTestId("fe5-inbox-unreadtoggle"));
    await waitFor(() => {
      // 3 unread items only
      expect(screen.getAllByTestId("fe5-inbox-unread-dot")).toHaveLength(3);
      expect(within(screen.getByTestId("fe5-inbox-list")).getAllByRole("listitem")).toHaveLength(3);
    });
    expect(window.location.search).toContain("unread=1");
  });

  it("clicking an unread item optimistically marks read + opens the detail dialog, whose link button navigates (tests 4,8)", async () => {
    const { deps, harness } = makeDeps();
    useUnreadStore.setState({ count: 3, initialized: true });
    renderWithDeps(<NotificationInboxPage initialFilter={{ unreadOnly: false, category: "all", type: "" }} />, deps);
    await screen.findByTestId("fe5-inbox-list");
    const user = userEvent.setup();
    await user.click(screen.getByTestId("fe5-inbox-item-notif_0001"));
    await waitFor(() => {
      expect(screen.getByTestId("fe5-inbox-item-notif_0001")).toHaveAttribute("data-unread", "false");
    });
    expect(useUnreadStore.getState().count).toBe(2); // optimistic decrement
    // The full-text / detail dialog opens; navigation happens from its link button, not the click.
    const dialog = await screen.findByTestId("fe5-notif-detail-dialog");
    expect(harness.navigate).not.toHaveBeenCalled();
    await user.click(within(dialog).getByTestId("fe5-notif-detail-open"));
    expect(harness.navigate).toHaveBeenCalledWith("/tasks/task_ship_fe5");
  });

  it("feedback notification shows the resolved sender name and its full body in the detail dialog", async () => {
    const { deps } = makeDeps();
    renderWithDeps(<NotificationInboxPage initialFilter={{ unreadOnly: false, category: "all", type: "" }} />, deps);
    await screen.findByTestId("fe5-inbox-list");
    // The card surfaces the resolved display name, not the raw actor id.
    const senderLabel = await screen.findByTestId("fe5-inbox-item-sender-notif_fb01");
    expect(senderLabel).toHaveTextContent("差出人: 山田 花子");
    const user = userEvent.setup();
    await user.click(screen.getByTestId("fe5-inbox-item-notif_fb01"));
    const dialog = await screen.findByTestId("fe5-notif-detail-dialog");
    expect(within(dialog).getByTestId("fe5-notif-detail-sender")).toHaveTextContent("山田 花子");
    // Full body (truncated in the card) is shown in full in the dialog.
    expect(within(dialog).getByTestId("fe5-notif-detail-body")).toHaveTextContent("一覧の軽量化");
    // No in-app link for feedback -> no "リンク先を開く" button, only 閉じる.
    expect(within(dialog).queryByTestId("fe5-notif-detail-open")).not.toBeInTheDocument();
    await user.click(within(dialog).getByTestId("fe5-notif-detail-close"));
    await waitFor(() => {
      expect(screen.queryByTestId("fe5-notif-detail-dialog")).not.toBeInTheDocument();
    });
  });

  it("404 on mark-read removes the row and toasts (test 6)", async () => {
    const { deps, harness } = makeDeps({
      failNext: {
        pathIncludes: "/read",
        error: new MockApiError("NOTIF_INBOX_ITEM_NOT_FOUND", 404, "gone"),
      },
    });
    renderWithDeps(<NotificationInboxPage initialFilter={{ unreadOnly: false, category: "all", type: "" }} />, deps);
    await screen.findByTestId("fe5-inbox-list");
    const user = userEvent.setup();
    await user.click(screen.getByTestId("fe5-inbox-item-notif_0001"));
    await waitFor(() => {
      expect(screen.queryByTestId("fe5-inbox-item-notif_0001")).not.toBeInTheDocument();
    });
    expect(harness.toast.show).toHaveBeenCalledWith("info", expect.stringMatching(/no longer available/i));
  });

  it("5xx on mark-read rolls back and toasts an error (test 5)", async () => {
    const { deps, harness } = makeDeps({
      failNext: { pathIncludes: "/read", error: new MockApiError("INTERNAL", 500, "boom", true) },
    });
    useUnreadStore.setState({ count: 3, initialized: true });
    renderWithDeps(<NotificationInboxPage initialFilter={{ unreadOnly: false, category: "all", type: "" }} />, deps);
    await screen.findByTestId("fe5-inbox-list");
    const user = userEvent.setup();
    await user.click(screen.getByTestId("fe5-inbox-item-notif_0001"));
    await waitFor(() => {
      expect(harness.toast.show).toHaveBeenCalledWith("error", expect.stringMatching(/try again/i));
    });
    // rolled back: still unread, count restored
    expect(screen.getByTestId("fe5-inbox-item-notif_0001")).toHaveAttribute("data-unread", "true");
    expect(useUnreadStore.getState().count).toBe(3);
  });

  it("mark-all-read with a type filter only clears that group (test 7)", async () => {
    const { deps, harness } = makeDeps();
    renderWithDeps(<NotificationInboxPage initialFilter={{ unreadOnly: false, category: "all", type: "task." }} />, deps);
    await screen.findByTestId("fe5-inbox-list");
    const user = userEvent.setup();
    await user.click(screen.getByTestId("fe5-inbox-markall"));
    await waitFor(() => {
      expect(screen.queryAllByTestId("fe5-inbox-unread-dot")).toHaveLength(0);
    });
    // server: non-task unread remain untouched
    const remainingUnread = harness.store.items.items.filter((i) => i.readAt === null);
    expect(remainingUnread.every((i) => !i.type.startsWith("task."))).toBe(true);
  });

  it("category tabs filter the list to their category (genre shown by tabs, not a per-card tag)", async () => {
    const { deps } = makeDeps();
    renderWithDeps(<NotificationInboxPage initialFilter={{ unreadOnly: false, category: "all", type: "" }} />, deps);
    await screen.findByTestId("fe5-inbox-list");
    const list = () => screen.getByTestId("fe5-inbox-list");
    const user = userEvent.setup();

    // メール tab -> only the mail item; genre is conveyed by the active tab + URL.
    await user.click(screen.getByTestId("fe5-inbox-catfilter-tab-mail"));
    await waitFor(() => {
      const rows = within(list()).getAllByRole("listitem");
      expect(rows).toHaveLength(1);
    });
    expect(window.location.search).toContain("cat=mail");

    // 参加届 tab -> only the participation item.
    await user.click(screen.getByTestId("fe5-inbox-catfilter-tab-participation"));
    await waitFor(() => {
      expect(within(list()).getAllByRole("listitem")).toHaveLength(1);
    });
    expect(window.location.search).toContain("cat=participation");

    // アプリアップデート tab -> the two release items.
    await user.click(screen.getByTestId("fe5-inbox-catfilter-tab-app_update"));
    await waitFor(() => {
      expect(within(list()).getAllByRole("listitem")).toHaveLength(2);
    });

    // フィードバック tab -> only the feedback item (type=feedback).
    await user.click(screen.getByTestId("fe5-inbox-catfilter-tab-feedback"));
    await waitFor(() => {
      expect(within(list()).getAllByRole("listitem")).toHaveLength(1);
    });
    expect(within(list()).getByTestId("fe5-inbox-item-notif_fb01")).toBeInTheDocument();
    expect(window.location.search).toContain("cat=feedback");

    // Back to すべて (All) -> everything is visible again (8 member-audience items).
    await user.click(screen.getByTestId("fe5-inbox-catfilter-tab-all"));
    await waitFor(() => {
      expect(within(list()).getAllByRole("listitem").length).toBeGreaterThan(2);
    });
  });

  it("shows an empty state when there are no notifications (test 14)", async () => {
    const { deps } = makeDeps({ items: [] });
    renderWithDeps(<NotificationInboxPage initialFilter={{ unreadOnly: false, category: "all", type: "" }} />, deps);
    expect(await screen.findByTestId("fe5-inbox-empty")).toBeInTheDocument();
  });
});
