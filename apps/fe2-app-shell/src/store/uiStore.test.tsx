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
});
