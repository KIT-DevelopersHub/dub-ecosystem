import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NotificationPreferencesPage } from "../src/components/NotificationPreferencesPage";
import { makeDeps, renderWithDeps } from "./helpers";

describe("NotificationPreferencesPage", () => {
  it("renders the merged matrix with a push column flagged display-only (tests 11,17)", async () => {
    const { deps } = makeDeps();
    renderWithDeps(<NotificationPreferencesPage />, deps);
    await screen.findByTestId("fe5-prefs-matrix");
    expect(screen.getByTestId("fe5-prefs-col-push")).toHaveTextContent("*"); // display-only marker
    expect(screen.getByTestId("fe5-prefs-col-in_app")).toBeInTheDocument();
    expect(screen.getByTestId("fe5-prefs-row-*")).toBeInTheDocument();
  });

  it("marks override rows as customized (test 11)", async () => {
    const { deps } = makeDeps({ overrides: [{ type: "task.*", channels: ["in_app"] }] });
    renderWithDeps(<NotificationPreferencesPage />, deps);
    await screen.findByTestId("fe5-prefs-matrix");
    expect(screen.getByTestId("fe5-prefs-override-task.*")).toBeInTheDocument();
  });

  it("toggling a channel and saving PATCHes only the diff (test 12)", async () => {
    const { deps, harness } = makeDeps();
    renderWithDeps(<NotificationPreferencesPage />, deps);
    await screen.findByTestId("fe5-prefs-matrix");
    const user = userEvent.setup();
    // "*" default is [in_app, push]; toggle email ON.
    await user.click(screen.getByTestId("fe5-prefs-toggle-*-email"));
    await user.click(screen.getByTestId("fe5-prefs-save"));
    await waitFor(() => {
      const ov = harness.store.items.overrides.find((o) => o.type === "*");
      expect(ov).toBeDefined();
      expect(new Set(ov!.channels)).toEqual(new Set(["in_app", "push", "email"]));
    });
    // only the changed row was sent (one override persisted)
    expect(harness.store.items.overrides).toHaveLength(1);
    expect(harness.toast.show).toHaveBeenCalledWith("success", expect.any(String));
  });
});
