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
    renderWithDeps(<NotificationInboxPage initialFilter={{ unreadOnly: false, type: "" }} />, deps);
    await screen.findByTestId("fe5-inbox-list");
    expect(screen.getByTestId("fe5-inbox-item-notif_0001")).toHaveAttribute("data-unread", "true");
    // seed has 3 unread items -> 3 dots
    expect(screen.getAllByTestId("fe5-inbox-unread-dot")).toHaveLength(3);
  });

  it("LoadMore appends the next page and stops at the end (test 2)", async () => {
    const { deps } = makeDeps();
    renderWithDeps(
      <NotificationInboxPage initialFilter={{ unreadOnly: false, type: "" }} pageSize={2} />,
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
    renderWithDeps(<NotificationInboxPage initialFilter={{ unreadOnly: false, type: "" }} />, deps);
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

  it("clicking an unread item optimistically marks read + navigates (tests 4,8)", async () => {
    const { deps, harness } = makeDeps();
    useUnreadStore.setState({ count: 3, initialized: true });
    renderWithDeps(<NotificationInboxPage initialFilter={{ unreadOnly: false, type: "" }} />, deps);
    await screen.findByTestId("fe5-inbox-list");
    const user = userEvent.setup();
    await user.click(screen.getByTestId("fe5-inbox-item-notif_0001"));
    await waitFor(() => {
      expect(screen.getByTestId("fe5-inbox-item-notif_0001")).toHaveAttribute("data-unread", "false");
    });
    expect(useUnreadStore.getState().count).toBe(2); // optimistic decrement
    expect(harness.navigate).toHaveBeenCalledWith("/tasks/task_ship_fe5");
  });

  it("404 on mark-read removes the row and toasts (test 6)", async () => {
    const { deps, harness } = makeDeps({
      failNext: {
        pathIncludes: "/read",
        error: new MockApiError("NOTIF_INBOX_ITEM_NOT_FOUND", 404, "gone"),
      },
    });
    renderWithDeps(<NotificationInboxPage initialFilter={{ unreadOnly: false, type: "" }} />, deps);
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
    renderWithDeps(<NotificationInboxPage initialFilter={{ unreadOnly: false, type: "" }} />, deps);
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
    renderWithDeps(<NotificationInboxPage initialFilter={{ unreadOnly: false, type: "task." }} />, deps);
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

  it("shows an empty state when there are no notifications (test 14)", async () => {
    const { deps } = makeDeps({ items: [] });
    renderWithDeps(<NotificationInboxPage initialFilter={{ unreadOnly: false, type: "" }} />, deps);
    expect(await screen.findByTestId("fe5-inbox-empty")).toBeInTheDocument();
  });
});
