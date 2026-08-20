// NotificationManagePage: lists admin notifications, publishes to members (optimistic
// badge flip + toast), handles the load error state, and stays idempotent on re-click.
import { describe, it, expect } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { NotificationManagePage } from "../src/components/NotificationManagePage";
import { MockApiError } from "../src/api/mock-client";
import type { AdminNotificationItem } from "../src/contracts/notification-api";
import { makeDeps, renderWithDeps } from "./helpers";

// Seed admin notifications where some are already published (drives the 公開解除 flows).
function publishedItem(id: string, type: string, published: boolean): AdminNotificationItem {
  return {
    id,
    type,
    title: `t-${id}`,
    body: "body",
    audience: "admin",
    createdAt: "2026-08-10T00:00:00Z",
    publishedBroadcastId: published ? `bc_${id}` : null,
  };
}

describe("NotificationManagePage", () => {
  it("lists the seeded admin notifications with a publish button (none published yet)", async () => {
    const { deps } = makeDeps();
    renderWithDeps(<NotificationManagePage />, deps);
    await waitFor(() => expect(screen.getAllByTestId("fe5-manage-item").length).toBeGreaterThan(0));
    expect(screen.getAllByTestId("fe5-publish-btn").length).toBe(3);
    expect(screen.queryByTestId("fe5-published-badge")).toBeNull();
  });

  it("publishes to members: the row flips to 公開済み and a success toast fires", async () => {
    const { deps, harness } = makeDeps();
    renderWithDeps(<NotificationManagePage />, deps);
    await waitFor(() => expect(screen.getAllByTestId("fe5-publish-btn").length).toBe(3));

    fireEvent.click(screen.getAllByTestId("fe5-publish-btn")[0]!);

    await waitFor(() => expect(screen.getAllByTestId("fe5-published-badge").length).toBe(1));
    expect(screen.getAllByTestId("fe5-publish-btn").length).toBe(2); // one converted to a badge
    await waitFor(() => expect(harness.toast.show).toHaveBeenCalledWith("success", expect.stringContaining("メンバー")));
    // A members broadcast is now in the inbox store (fan-out).
    expect(harness.store.items.items.some((i) => i.type === "system.announcement" && i.audience === "members")).toBe(true);
  });

  it("rolls back the optimistic badge and toasts on a publish failure", async () => {
    const { deps } = makeDeps({
      failNext: { pathIncludes: "/manage/", error: new MockApiError("NOTIF_INTERNAL", 500, "boom", true) },
    });
    renderWithDeps(<NotificationManagePage />, deps);
    await waitFor(() => expect(screen.getAllByTestId("fe5-publish-btn").length).toBe(3));

    fireEvent.click(screen.getAllByTestId("fe5-publish-btn")[0]!);

    // Optimistic badge appears then rolls back to a button (still 3 publishable rows).
    await waitFor(() => expect(screen.getAllByTestId("fe5-publish-btn").length).toBe(3));
    expect(screen.queryByTestId("fe5-published-badge")).toBeNull();
  });

  it("shows an error state with retry when the list fails to load", async () => {
    const { deps } = makeDeps({
      failNext: { pathIncludes: "/manage", error: new MockApiError("NOTIF_INTERNAL", 500, "down", true) },
    });
    renderWithDeps(<NotificationManagePage />, deps);
    await waitFor(() => expect(screen.getByTestId("fe5-manage-error")).toBeTruthy());
  });

  it("select-all → bulk publish flips every row to 公開済み in one action", async () => {
    const { deps, harness } = makeDeps();
    renderWithDeps(<NotificationManagePage />, deps);
    await waitFor(() => expect(screen.getAllByTestId("fe5-publish-btn").length).toBe(3));

    fireEvent.click(screen.getByLabelText("すべて選択"));
    expect(screen.getByTestId("fe5-selected-count").textContent).toBe("3件選択中");

    fireEvent.click(screen.getByTestId("fe5-bulk-publish-btn"));

    await waitFor(() => expect(screen.getAllByTestId("fe5-published-badge").length).toBe(3));
    expect(screen.queryByTestId("fe5-publish-btn")).toBeNull();
    expect(screen.getByTestId("fe5-selected-count").textContent).toBe("0件選択中");
    await waitFor(() => expect(harness.toast.show).toHaveBeenCalledWith("success", expect.stringContaining("3件を公開")));
    // 3 members broadcasts fanned into the inbox store (broadcasts carry resourceType="notification").
    expect(harness.store.items.items.filter((i) => i.resourceType === "notification").length).toBe(3);
  });

  it("genre filter narrows the list; selection resets on filter change", async () => {
    const { deps } = makeDeps();
    renderWithDeps(<NotificationManagePage />, deps);
    await waitFor(() => expect(screen.getAllByTestId("fe5-manage-item").length).toBe(3));

    fireEvent.click(screen.getByLabelText("すべて選択"));
    expect(screen.getByTestId("fe5-selected-count").textContent).toBe("3件選択中");

    // Switch to the 新機能 (release) tab → only the release notification remains.
    fireEvent.click(screen.getByRole("tab", { name: /新機能/ }));
    await waitFor(() => expect(screen.getAllByTestId("fe5-manage-item").length).toBe(1));
    // Filter change reset the selection.
    expect(screen.getByTestId("fe5-selected-count").textContent).toBe("0件選択中");
  });

  it("unpublishes a published row: 公開解除 retracts it back to a publish button + success toast", async () => {
    const { deps, harness } = makeDeps({
      adminItems: [publishedItem("a", "release", true), publishedItem("b", "feedback", false)],
    });
    renderWithDeps(<NotificationManagePage />, deps);
    await waitFor(() => expect(screen.getAllByTestId("fe5-manage-item").length).toBe(2));
    expect(screen.getAllByTestId("fe5-published-badge").length).toBe(1);
    expect(screen.getAllByTestId("fe5-unpublish-btn").length).toBe(1);

    fireEvent.click(screen.getByTestId("fe5-unpublish-btn"));

    // The published badge / 公開解除 button go away; both rows are now publishable.
    await waitFor(() => expect(screen.queryByTestId("fe5-published-badge")).toBeNull());
    expect(screen.getAllByTestId("fe5-publish-btn").length).toBe(2);
    await waitFor(() => expect(harness.toast.show).toHaveBeenCalledWith("success", expect.stringContaining("解除")));
  });

  it("rolls back the optimistic unpublish and toasts on failure", async () => {
    const { deps } = makeDeps({
      adminItems: [publishedItem("a", "release", true)],
      failNext: { pathIncludes: "/unpublish", error: new MockApiError("NOTIF_INTERNAL", 500, "boom", true) },
    });
    renderWithDeps(<NotificationManagePage />, deps);
    await waitFor(() => expect(screen.getByTestId("fe5-unpublish-btn")).toBeTruthy());

    fireEvent.click(screen.getByTestId("fe5-unpublish-btn"));

    // Optimistically flips to publishable then rolls back to 公開済み.
    await waitFor(() => expect(screen.getByTestId("fe5-published-badge")).toBeTruthy());
    expect(screen.queryByTestId("fe5-publish-btn")).toBeNull();
  });

  it("select-all → bulk 公開解除 retracts every published row in one action", async () => {
    const { deps, harness } = makeDeps({
      adminItems: [publishedItem("a", "release", true), publishedItem("b", "release", true)],
    });
    renderWithDeps(<NotificationManagePage />, deps);
    await waitFor(() => expect(screen.getAllByTestId("fe5-unpublish-btn").length).toBe(2));

    fireEvent.click(screen.getByLabelText("すべて選択"));
    expect(screen.getByTestId("fe5-selected-count").textContent).toBe("2件選択中");

    fireEvent.click(screen.getByTestId("fe5-bulk-unpublish-btn"));

    await waitFor(() => expect(screen.queryByTestId("fe5-published-badge")).toBeNull());
    expect(screen.getAllByTestId("fe5-publish-btn").length).toBe(2);
    expect(screen.getByTestId("fe5-selected-count").textContent).toBe("0件選択中");
    await waitFor(() => expect(harness.toast.show).toHaveBeenCalledWith("success", expect.stringContaining("公開解除")));
  });

  it("bulk publishes only the filtered category when select-all is used after filtering", async () => {
    const { deps, harness } = makeDeps();
    renderWithDeps(<NotificationManagePage />, deps);
    await waitFor(() => expect(screen.getAllByTestId("fe5-manage-item").length).toBe(3));

    fireEvent.click(screen.getByRole("tab", { name: /新機能/ }));
    await waitFor(() => expect(screen.getAllByTestId("fe5-manage-item").length).toBe(1));
    fireEvent.click(screen.getByLabelText("すべて選択"));
    expect(screen.getByTestId("fe5-selected-count").textContent).toBe("1件選択中");
    fireEvent.click(screen.getByTestId("fe5-bulk-publish-btn"));

    await waitFor(() => expect(screen.getAllByTestId("fe5-published-badge").length).toBe(1));
    // Only 1 broadcast created (the release), not all 3.
    expect(harness.store.items.items.filter((i) => i.resourceType === "notification").length).toBe(1);
  });
});
