import { describe, it, expect, beforeEach, vi } from "vitest";
import { useUiStore } from "./uiStore.tsx";

describe("useUiStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({ sidebarOpen: true, theme: "system", homeGrid: { positions: {}, sizes: {} } });
  });

  it("defaults theme to system and sidebar open", () => {
    const s = useUiStore.getState();
    expect(s.theme).toBe("system");
    expect(s.sidebarOpen).toBe(true);
  });

  it("setTheme persists to localStorage (dub.ui.theme)", () => {
    useUiStore.getState().setTheme("dark");
    expect(useUiStore.getState().theme).toBe("dark");
    expect(localStorage.getItem("dub.ui.theme")).toBe("dark");
  });

  it("toggleSidebar flips and persists", () => {
    useUiStore.getState().toggleSidebar();
    expect(useUiStore.getState().sidebarOpen).toBe(false);
    expect(localStorage.getItem("dub.ui.sidebar")).toBe("closed");
  });

  describe("homeGrid (Home widget placement)", () => {
    it("defaults to no positions and no sizes", () => {
      expect(useUiStore.getState().homeGrid).toEqual({ positions: {}, sizes: {} });
    });

    it("setHomeGridPositions merges (does not replace) the position map and persists it", () => {
      useUiStore.getState().setHomeGridPositions([{ id: "usage", x: 0, y: 0 }]);
      useUiStore.getState().setHomeGridPositions([{ id: "tasks", x: 2, y: 0 }]);
      expect(useUiStore.getState().homeGrid.positions).toEqual({
        usage: { x: 0, y: 0 },
        tasks: { x: 2, y: 0 },
      });
      const persisted = JSON.parse(localStorage.getItem("dub.ui.home.grid")!);
      expect(persisted.positions.usage).toEqual({ x: 0, y: 0 });
    });

    it("a later position for the same widget overwrites its earlier one", () => {
      useUiStore.getState().setHomeGridPositions([{ id: "usage", x: 0, y: 0 }]);
      useUiStore.getState().setHomeGridPositions([{ id: "usage", x: 3, y: 1 }]);
      expect(useUiStore.getState().homeGrid.positions.usage).toEqual({ x: 3, y: 1 });
    });

    it("setHomeWidgetSize sets one widget's size and persists it", () => {
      useUiStore.getState().setHomeWidgetSize("usage", "large");
      expect(useUiStore.getState().homeGrid.sizes.usage).toBe("large");
      const persisted = JSON.parse(localStorage.getItem("dub.ui.home.grid")!);
      expect(persisted.sizes.usage).toBe("large");
    });

    it("resetHomeGrid clears both maps and persists the reset", () => {
      useUiStore.getState().setHomeGridPositions([{ id: "usage", x: 0, y: 0 }]);
      useUiStore.getState().setHomeWidgetSize("usage", "large");
      useUiStore.getState().resetHomeGrid();
      expect(useUiStore.getState().homeGrid).toEqual({ positions: {}, sizes: {} });
      expect(JSON.parse(localStorage.getItem("dub.ui.home.grid")!)).toEqual({ positions: {}, sizes: {} });
    });

    it("ignores a malformed dub.ui.home.grid value in storage (falls back to empty) on fresh init", async () => {
      localStorage.setItem("dub.ui.home.grid", "{not json");
      vi.resetModules();
      const fresh = await import("./uiStore.tsx");
      expect(fresh.useUiStore.getState().homeGrid).toEqual({ positions: {}, sizes: {} });
    });

    it("drops an invalid size value read from storage but keeps a valid sibling", async () => {
      localStorage.setItem(
        "dub.ui.home.grid",
        JSON.stringify({ positions: { usage: { x: 0, y: 0 } }, sizes: { usage: "huge", tasks: "medium" } }),
      );
      vi.resetModules();
      const fresh = await import("./uiStore.tsx");
      expect(fresh.useUiStore.getState().homeGrid).toEqual({
        positions: { usage: { x: 0, y: 0 } },
        sizes: { tasks: "medium" },
      });
    });
  });
});
