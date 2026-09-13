import { describe, it, expect, beforeEach, vi } from "vitest";
import { useUiStore } from "./uiStore.tsx";

describe("useUiStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({
      sidebarOpen: true,
      theme: "system",
      homeGrid: { positions: {}, sizes: {} },
      homeGridEditMode: false,
      homeGridHidden: [],
    });
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

  describe("homeGridEditMode (静的表示 <-> 編集モード toggle)", () => {
    it("defaults to false (normal/static mode) on first-ever load", () => {
      expect(useUiStore.getState().homeGridEditMode).toBe(false);
    });

    it("setHomeGridEditMode(true) enters edit mode and persists it", () => {
      useUiStore.getState().setHomeGridEditMode(true);
      expect(useUiStore.getState().homeGridEditMode).toBe(true);
      expect(localStorage.getItem("dub.ui.home.gridEditMode")).toBe("1");
    });

    it("setHomeGridEditMode(false) ('完了') returns to static mode and persists it", () => {
      useUiStore.getState().setHomeGridEditMode(true);
      useUiStore.getState().setHomeGridEditMode(false);
      expect(useUiStore.getState().homeGridEditMode).toBe(false);
      expect(localStorage.getItem("dub.ui.home.gridEditMode")).toBe("0");
    });

    it("a persisted edit-mode=true survives a fresh module init (reload)", async () => {
      localStorage.setItem("dub.ui.home.gridEditMode", "1");
      vi.resetModules();
      const fresh = await import("./uiStore.tsx");
      expect(fresh.useUiStore.getState().homeGridEditMode).toBe(true);
    });

    it("a fresh init with no stored key at all defaults to static mode, not edit mode", async () => {
      vi.resetModules();
      const fresh = await import("./uiStore.tsx");
      expect(fresh.useUiStore.getState().homeGridEditMode).toBe(false);
    });
  });

  describe("homeGridHidden (ウィジェットの追加・削除)", () => {
    it("defaults to no hidden widgets", () => {
      expect(useUiStore.getState().homeGridHidden).toEqual([]);
    });

    it("hideHomeWidget adds the id and persists it", () => {
      useUiStore.getState().hideHomeWidget("usage");
      expect(useUiStore.getState().homeGridHidden).toEqual(["usage"]);
      expect(JSON.parse(localStorage.getItem("dub.ui.home.gridHidden")!)).toEqual(["usage"]);
    });

    it("hideHomeWidget is idempotent (does not duplicate an already-hidden id)", () => {
      useUiStore.getState().hideHomeWidget("usage");
      useUiStore.getState().hideHomeWidget("usage");
      expect(useUiStore.getState().homeGridHidden).toEqual(["usage"]);
    });

    it("hideHomeWidget appends without disturbing other hidden ids", () => {
      useUiStore.getState().hideHomeWidget("usage");
      useUiStore.getState().hideHomeWidget("tasks");
      expect(useUiStore.getState().homeGridHidden).toEqual(["usage", "tasks"]);
    });

    it("showHomeWidget removes the id and persists it", () => {
      useUiStore.getState().hideHomeWidget("usage");
      useUiStore.getState().hideHomeWidget("tasks");
      useUiStore.getState().showHomeWidget("usage");
      expect(useUiStore.getState().homeGridHidden).toEqual(["tasks"]);
      expect(JSON.parse(localStorage.getItem("dub.ui.home.gridHidden")!)).toEqual(["tasks"]);
    });

    it("showHomeWidget on an id that is not hidden is a no-op", () => {
      useUiStore.getState().showHomeWidget("usage");
      expect(useUiStore.getState().homeGridHidden).toEqual([]);
    });

    it("a persisted hidden list survives a fresh module init (reload)", async () => {
      localStorage.setItem("dub.ui.home.gridHidden", JSON.stringify(["notifications"]));
      vi.resetModules();
      const fresh = await import("./uiStore.tsx");
      expect(fresh.useUiStore.getState().homeGridHidden).toEqual(["notifications"]);
    });

    it("ignores a malformed dub.ui.home.gridHidden value in storage (falls back to empty)", async () => {
      localStorage.setItem("dub.ui.home.gridHidden", "{not json");
      vi.resetModules();
      const fresh = await import("./uiStore.tsx");
      expect(fresh.useUiStore.getState().homeGridHidden).toEqual([]);
    });

    it("drops non-string entries read from storage but keeps valid siblings", async () => {
      localStorage.setItem("dub.ui.home.gridHidden", JSON.stringify(["usage", 42, null, "tasks"]));
      vi.resetModules();
      const fresh = await import("./uiStore.tsx");
      expect(fresh.useUiStore.getState().homeGridHidden).toEqual(["usage", "tasks"]);
    });
  });
});
