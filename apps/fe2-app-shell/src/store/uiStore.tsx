// UI state store (Zustand) — FE2 is the ONLY unit allowed a global store.
// Theme is FE2's source of truth (localStorage "dub.ui.theme"); FE1 ThemeProvider
// is controlled and receives this value. Sidebar persists to "dub.ui.sidebar".
import { create } from "zustand";

// FE2 owns the theme source of truth including "system" (@dub/ui ThemeProvider is
// controlled and only accepts the resolved "light"|"dark"; AppRoot resolves "system").
export type ThemeValue = "light" | "dark" | "system";

const THEME_KEY = "dub.ui.theme";
const SIDEBAR_KEY = "dub.ui.sidebar";
// 右側の AI パネルの開閉 (既定は閉じる)。
const AI_PANEL_KEY = "dub.ui.aiPanel";

export interface UiStore {
  sidebarOpen: boolean;
  theme: ThemeValue;
  aiPanelOpen: boolean;
  toggleSidebar(): void;
  toggleAiPanel(): void;
  setAiPanelOpen(open: boolean): void;
  setSidebarOpen(open: boolean): void;
  setTheme(t: ThemeValue): void;
}

function readTheme(): ThemeValue {
  try {
    const v = globalThis.localStorage?.getItem(THEME_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* no storage */
  }
  return "system";
}

function readSidebar(): boolean {
  try {
    return globalThis.localStorage?.getItem(SIDEBAR_KEY) !== "closed";
  } catch {
    return true;
  }
}

function readAiPanel(): boolean {
  try {
    return globalThis.localStorage?.getItem(AI_PANEL_KEY) === "open";
  } catch {
    return false;
  }
}

function persist(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* no storage */
  }
}

export const useUiStore = create<UiStore>((set, get) => ({
  sidebarOpen: readSidebar(),
  theme: readTheme(),
  aiPanelOpen: readAiPanel(),
  toggleAiPanel: () => {
    const next = !get().aiPanelOpen;
    persist(AI_PANEL_KEY, next ? "open" : "closed");
    set({ aiPanelOpen: next });
  },
  setAiPanelOpen: (open: boolean) => {
    persist(AI_PANEL_KEY, open ? "open" : "closed");
    set({ aiPanelOpen: open });
  },
  toggleSidebar: () => {
    const next = !get().sidebarOpen;
    persist(SIDEBAR_KEY, next ? "open" : "closed");
    set({ sidebarOpen: next });
  },
  setSidebarOpen: (open: boolean) => {
    persist(SIDEBAR_KEY, open ? "open" : "closed");
    set({ sidebarOpen: open });
  },
  setTheme: (t: ThemeValue) => {
    persist(THEME_KEY, t);
    set({ theme: t });
  },
}));
