// NotificationManagePage: lists admin notifications, publishes to members (optimistic
// badge flip + toast), handles the load error state, and stays idempotent on re-click.
import { describe, it, expect } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { NotificationManagePage } from "../src/components/NotificationManagePage";
import { MockApiError } from "../src/api/mock-client";
import { makeDeps, renderWithDeps } from "./helpers";

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
});
