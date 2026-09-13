// HomeWidgetGrid: the add/remove UI layered on top of the real cell grid
// (placement/resize itself is covered end-to-end in
// e2e/home-widget-grid-layout.spec.ts; this file is the fast jsdom coverage for
// the ×-remove button, the "ウィジェットを追加" menu, its empty state, and
// dub.ui.home.gridHidden persistence). Renders the component directly (not via
// HomeScreen) with a small fake catalog — no BFF/network involved.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "../../../store/uiStore.tsx";
import { HomeWidgetGrid } from "./HomeWidgetGrid.tsx";
import type { GridWidgetMeta } from "./homeGrid.ts";

const CATALOG: GridWidgetMeta[] = [
  { id: "a", label: "ウィジェットA" },
  { id: "b", label: "ウィジェットB" },
  { id: "c", label: "ウィジェットC" },
];

const NODES: Record<string, JSX.Element> = {
  a: <p>content-a</p>,
  b: <p>content-b</p>,
  c: <p>content-c</p>,
};

function resetStore(editMode: boolean): void {
  localStorage.clear();
  useUiStore.setState({
    sidebarOpen: true,
    theme: "system",
    homeGrid: { positions: {}, sizes: {} },
    homeGridEditMode: editMode,
    homeGridHidden: [],
  });
}

describe("HomeWidgetGrid — add/remove", () => {
  beforeEach(() => {
    resetStore(true);
  });

  it("normal mode shows every widget with no remove button and no add-menu trigger", () => {
    resetStore(false);
    render(<HomeWidgetGrid catalog={CATALOG} nodes={NODES} />);
    expect(screen.getByTestId("fe2-widget-grid-item-a")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-widget-grid-item-b")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-widget-grid-item-c")).toBeInTheDocument();
    expect(screen.queryByTestId("fe2-widget-grid-remove-a")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe2-widget-grid-add-trigger")).not.toBeInTheDocument();
  });

  it("edit mode shows a × remove button per widget; clicking it drops the widget and persists to dub.ui.home.gridHidden", async () => {
    render(<HomeWidgetGrid catalog={CATALOG} nodes={NODES} />);
    expect(screen.getByTestId("fe2-widget-grid-item-a")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("fe2-widget-grid-remove-a"));

    expect(screen.queryByTestId("fe2-widget-grid-item-a")).not.toBeInTheDocument();
    expect(screen.getByTestId("fe2-widget-grid-item-b")).toBeInTheDocument();
    expect(useUiStore.getState().homeGridHidden).toEqual(["a"]);
    expect(JSON.parse(localStorage.getItem("dub.ui.home.gridHidden")!)).toEqual(["a"]);
  });

  it("追加 menu shows an empty state when nothing has been removed", async () => {
    render(<HomeWidgetGrid catalog={CATALOG} nodes={NODES} />);
    await userEvent.click(screen.getByTestId("fe2-widget-grid-add-trigger"));
    expect(screen.getByTestId("fe2-widget-grid-add-empty")).toHaveTextContent(
      "追加できるウィジェットはありません",
    );
  });

  it("追加 menu lists a removed widget; selecting it re-adds the widget to the grid and clears it from gridHidden", async () => {
    useUiStore.getState().hideHomeWidget("a");
    render(<HomeWidgetGrid catalog={CATALOG} nodes={NODES} />);
    expect(screen.queryByTestId("fe2-widget-grid-item-a")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("fe2-widget-grid-add-trigger"));
    const item = screen.getByTestId("fe2-widget-grid-add-item-a");
    expect(within(item).getByText("ウィジェットA")).toBeInTheDocument();
    await userEvent.click(item);

    expect(screen.getByTestId("fe2-widget-grid-item-a")).toBeInTheDocument();
    expect(useUiStore.getState().homeGridHidden).toEqual([]);
    expect(JSON.parse(localStorage.getItem("dub.ui.home.gridHidden")!)).toEqual([]);
  });

  it("追加 menu only lists widgets that were removed, not ones still on the grid", async () => {
    useUiStore.getState().hideHomeWidget("b");
    render(<HomeWidgetGrid catalog={CATALOG} nodes={NODES} />);
    await userEvent.click(screen.getByTestId("fe2-widget-grid-add-trigger"));
    expect(screen.getByTestId("fe2-widget-grid-add-item-b")).toBeInTheDocument();
    expect(screen.queryByTestId("fe2-widget-grid-add-item-a")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe2-widget-grid-add-item-c")).not.toBeInTheDocument();
  });

  it("removing every widget shows the empty-state prompt but keeps the toolbar (edit toggle + add menu) reachable", async () => {
    render(<HomeWidgetGrid catalog={CATALOG} nodes={NODES} />);
    await userEvent.click(screen.getByTestId("fe2-widget-grid-remove-a"));
    await userEvent.click(screen.getByTestId("fe2-widget-grid-remove-b"));
    await userEvent.click(screen.getByTestId("fe2-widget-grid-remove-c"));

    expect(screen.getByTestId("fe2-home-widget-grid-empty")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-home-widget-grid-edit-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-widget-grid-add-trigger")).toBeInTheDocument();
    expect(useUiStore.getState().homeGridHidden.sort()).toEqual(["a", "b", "c"]);
  });

  it("a widget hidden in a previous session stays hidden after a fresh mount (persisted)", () => {
    useUiStore.getState().hideHomeWidget("c");
    const { unmount } = render(<HomeWidgetGrid catalog={CATALOG} nodes={NODES} />);
    expect(screen.queryByTestId("fe2-widget-grid-item-c")).not.toBeInTheDocument();
    unmount();

    render(<HomeWidgetGrid catalog={CATALOG} nodes={NODES} />);
    expect(screen.queryByTestId("fe2-widget-grid-item-c")).not.toBeInTheDocument();
    expect(screen.getByTestId("fe2-widget-grid-item-a")).toBeInTheDocument();
  });
});
