import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, setAuth, resetAuth, makeNav } from "./util";
import { SavedViewsBar } from "../src/components/SavedViewsBar";
import { EventListPage } from "../src/pages/EventListPage";
import { loadSavedViews, persistSavedViews, addView, emptySavedViews } from "../src/lib/savedViews";

beforeEach(() => {
  resetAuth();
  localStorage.clear();
});
afterEach(() => {
  resetAuth();
  localStorage.clear();
});

describe("SavedViewsBar (P2-2)", () => {
  it("saves the current filter as a named view and re-applies it in one click", async () => {
    const applied: string[] = [];
    renderWithProviders(
      <SavedViewsBar currentQuery="phase=open" onApply={(q) => applied.push(q)} />,
    );

    // Open the menu, choose "save current filter".
    await userEvent.click(screen.getByTestId("fe3-savedviews-menu-trigger"));
    await userEvent.click(screen.getByTestId("fe3-savedviews-save"));

    // Name it and confirm.
    await userEvent.type(screen.getByTestId("fe3-savedviews-name"), "開催中");
    await userEvent.click(screen.getByTestId("fe3-savedviews-save-confirm"));

    // Persisted.
    await waitFor(() => expect(loadSavedViews().views).toHaveLength(1));
    expect(loadSavedViews().views[0]).toMatchObject({ name: "開催中", query: "phase=open" });

    // Re-open the menu; applying the saved view calls onApply with its query.
    await userEvent.click(screen.getByTestId("fe3-savedviews-menu-trigger"));
    const applyItem = await screen.findByText("開催中");
    await userEvent.click(applyItem);
    expect(applied).toContain("phase=open");
  });

  it("marks a view default when the checkbox is ticked at save time", async () => {
    renderWithProviders(<SavedViewsBar currentQuery="archived=1" onApply={() => {}} />);
    await userEvent.click(screen.getByTestId("fe3-savedviews-menu-trigger"));
    await userEvent.click(screen.getByTestId("fe3-savedviews-save"));
    await userEvent.type(screen.getByTestId("fe3-savedviews-name"), "アーカイブ");
    await userEvent.click(screen.getByTestId("fe3-savedviews-default"));
    await userEvent.click(screen.getByTestId("fe3-savedviews-save-confirm"));

    await waitFor(() => {
      const s = loadSavedViews();
      expect(s.views).toHaveLength(1);
      expect(s.defaultId).toBe(s.views[0]?.id);
    });
  });

  it("deletes a view from the management dialog", async () => {
    persistSavedViews(addView(emptySavedViews(), "消す対象", "phase=live", { id: "v1" }));
    renderWithProviders(<SavedViewsBar currentQuery="" onApply={() => {}} />);

    await userEvent.click(screen.getByTestId("fe3-savedviews-menu-trigger"));
    await userEvent.click(screen.getByTestId("fe3-savedviews-manage"));
    await userEvent.click(screen.getByTestId("fe3-savedviews-delete-v1"));

    await waitFor(() => expect(loadSavedViews().views).toHaveLength(0));
  });
});

describe("EventListPage default saved view (P2-2)", () => {
  it("auto-applies the default view when opened with no URL filter", async () => {
    persistSavedViews(addView(emptySavedViews(), "既定", "phase=live", { id: "v1", makeDefault: true }));
    setAuth(["event:read"]);
    const nav = makeNav({ search: "" });
    renderWithProviders(<EventListPage />, { nav });
    await waitFor(() => expect(nav.setSearch).toHaveBeenCalledWith("phase=live"));
  });

  it("does NOT override an explicit URL filter with the default view", async () => {
    persistSavedViews(addView(emptySavedViews(), "既定", "phase=live", { id: "v1", makeDefault: true }));
    setAuth(["event:read"]);
    const nav = makeNav({ search: "phase=open" });
    renderWithProviders(<EventListPage />, { nav });
    await screen.findByTestId("fe3-eventlist-phase-filter");
    expect(nav.setSearch).not.toHaveBeenCalledWith("phase=live");
  });
});
