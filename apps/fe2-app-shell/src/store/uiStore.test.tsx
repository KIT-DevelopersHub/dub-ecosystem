import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "./uiStore.tsx";

describe("useUiStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({ sidebarOpen: true, theme: "system" });
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

  describe("home dashboard prefs (P3-2)", () => {
    beforeEach(() => {
      localStorage.clear();
      useUiStore.setState({ homeDensity: "comfortable", homeLayout: { order: [], hidden: [], sizes: {} } });
    });

    it("defaults to comfortable density and an empty layout", () => {
      const s = useUiStore.getState();
      expect(s.homeDensity).toBe("comfortable");
      expect(s.homeLayout).toEqual({ order: [], hidden: [], sizes: {} });
    });

    it("setHomeDensity persists to localStorage (dub.ui.home.density)", () => {
      useUiStore.getState().setHomeDensity("compact");
      expect(useUiStore.getState().homeDensity).toBe("compact");
      expect(localStorage.getItem("dub.ui.home.density")).toBe("compact");
    });

    it("setHomeWidgetHidden adds and removes ids, persisting the layout JSON", () => {
      useUiStore.getState().setHomeWidgetHidden("kpi-members", true);
      expect(useUiStore.getState().homeLayout.hidden).toContain("kpi-members");
      expect(JSON.parse(localStorage.getItem("dub.ui.home.layout")!).hidden).toContain("kpi-members");
      // Idempotent: hiding an already-hidden widget does not duplicate it.
      useUiStore.getState().setHomeWidgetHidden("kpi-members", true);
      expect(useUiStore.getState().homeLayout.hidden).toEqual(["kpi-members"]);
      // Unhiding removes it.
      useUiStore.getState().setHomeWidgetHidden("kpi-members", false);
      expect(useUiStore.getState().homeLayout.hidden).not.toContain("kpi-members");
    });

    it("setHomeWidgetOrder persists the full order", () => {
      useUiStore.getState().setHomeWidgetOrder(["kpi-tasks", "kpi-countdown"]);
      expect(useUiStore.getState().homeLayout.order).toEqual(["kpi-tasks", "kpi-countdown"]);
      expect(JSON.parse(localStorage.getItem("dub.ui.home.layout")!).order).toEqual(["kpi-tasks", "kpi-countdown"]);
    });

    it("resetHomeLayout clears order/hidden/sizes and restores comfortable density", () => {
      useUiStore.getState().setHomeDensity("compact");
      useUiStore.getState().setHomeWidgetHidden("card-usage", true);
      useUiStore.getState().setHomeWidgetOrder(["card-tasks", "card-usage"]);
      useUiStore.getState().setHomeWidgetSize("kpi-members", "large");
      useUiStore.getState().resetHomeLayout();
      const s = useUiStore.getState();
      expect(s.homeLayout).toEqual({ order: [], hidden: [], sizes: {} });
      expect(s.homeDensity).toBe("comfortable");
      expect(localStorage.getItem("dub.ui.home.density")).toBe("comfortable");
    });

    it("setHomeWidgetSize sets a widget's size, persisting the layout JSON (P3-4)", () => {
      useUiStore.getState().setHomeWidgetSize("kpi-members", "large");
      expect(useUiStore.getState().homeLayout.sizes["kpi-members"]).toBe("large");
      expect(JSON.parse(localStorage.getItem("dub.ui.home.layout")!).sizes["kpi-members"]).toBe("large");
      // Switching sizes overwrites, never accumulates entries for the same id.
      useUiStore.getState().setHomeWidgetSize("kpi-members", "medium");
      expect(useUiStore.getState().homeLayout.sizes).toEqual({ "kpi-members": "medium" });
      // Sizing one widget never touches order/hidden.
      useUiStore.getState().setHomeWidgetHidden("card-usage", true);
      useUiStore.getState().setHomeWidgetSize("card-usage", "small");
      expect(useUiStore.getState().homeLayout.hidden).toContain("card-usage");
    });
  });
});
