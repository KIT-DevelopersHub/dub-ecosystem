import { act } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NotificationBell } from "../src/components/NotificationBell";
import { useNotificationDialogStore } from "../src/store/dialog-store";
import type { LiveConnector, LiveHandlers } from "../src/lib/unread-live";
import { makeDeps, renderWithDeps } from "./helpers";

describe("NotificationBell (headerWidget)", () => {
  // The dialog open-state is a module singleton; reset it so tests don't leak.
  beforeEach(() => useNotificationDialogStore.setState({ open: false }));

  it("shows the unread badge from the polled count (test 9)", async () => {
    const { deps } = makeDeps();
    renderWithDeps(<NotificationBell />, deps);
    // seed has 3 unread -> badge "3"
    await waitFor(() => {
      expect(screen.getByTestId("fe5-bell-badge")).toHaveTextContent("3");
    });
  });

  it("hides the badge when there are no unread items (test 9)", async () => {
    const seedAllRead = {
      items: [
        {
          id: "notif_r1",
          type: "task.assigned",
          title: "read one",
          body: "",
          readAt: "2026-08-09T00:00:00Z",
          createdAt: "2026-08-09T00:00:00Z",
          resourceType: null,
          resourceId: null,
        },
      ],
    };
    const { deps } = makeDeps(seedAllRead);
    renderWithDeps(<NotificationBell />, deps);
    await waitFor(() => {
      expect(screen.queryByTestId("fe5-bell-badge")).not.toBeInTheDocument();
    });
  });

  it("opens the shared notification dialog and lists the inbox when clicked", async () => {
    const { deps } = makeDeps();
    renderWithDeps(<NotificationBell />, deps);
    const user = userEvent.setup();
    // The dialog is closed initially (no inbox rendered).
    expect(screen.queryByTestId("fe5-notif-dialog")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("fe5-bell-button"));
    // Same modal both entry points share; renders the reused inbox list.
    await screen.findByTestId("fe5-notif-dialog");
    await screen.findByTestId("fe5-inbox-list");
    expect(screen.getByTestId("fe5-inbox-list")).toBeInTheDocument();
  });

  it("updates the badge from a live push after the initial poll settles", async () => {
    // Capture the live handlers so the test can push a server count on demand.
    let handlers: LiveHandlers | null = null;
    const unreadLiveConnect: LiveConnector = (h) => {
      handlers = h;
      h.onOpen?.();
      return { close: () => {} };
    };
    const { deps } = makeDeps({}, { unreadLiveConnect });
    renderWithDeps(<NotificationBell />, deps);

    // Initial poll seeds the badge from the mock store (3 unread).
    await waitFor(() => expect(screen.getByTestId("fe5-bell-badge")).toHaveTextContent("3"));

    // A live push overrides it immediately — no poll in between (interval disabled).
    act(() => handlers!.onCount(7));
    await waitFor(() => expect(screen.getByTestId("fe5-bell-badge")).toHaveTextContent("7"));

    // A push of 0 hides the badge (single source of truth honoured).
    act(() => handlers!.onCount(0));
    await waitFor(() => expect(screen.queryByTestId("fe5-bell-badge")).not.toBeInTheDocument());
  });
});
