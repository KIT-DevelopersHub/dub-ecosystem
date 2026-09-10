// UI state store (Zustand) — FE2 is the ONLY unit allowed a global store.
// Theme is FE2's source of truth (localStorage "dub.ui.theme"); FE1 ThemeProvider
// is controlled and receives this value. Sidebar persists to "dub.ui.sidebar".
//
// It is also the persisted receptacle for per-viewer Home dashboard preferences
// (P3-2): each role can shape their own dashboard by reordering / hiding widgets
// and switching the display density (通常 / コンパクト). Order + hidden set persist
// to "dub.ui.home.layout" (JSON) and density to "dub.ui.home.density", so a viewer's
// layout survives reload. The HomeScreen owns the widget catalog and applies these
// prefs; the store only stores and persists them.
import { create } from "zustand";
import type { WidgetSize } from "../shell/screens/dashboard/homeLayout.ts";

export type { WidgetSize };

// FE2 owns the theme source of truth including "system" (@dub/ui ThemeProvider is
// controlled and only accepts the resolved "light"|"dark"; AppRoot resolves "system").
export type ThemeValue = "light" | "dark" | "system";

// Home dashboard display density. "comfortable" is the default (roomy spacing);
// "compact" tightens gaps/padding so more fits in the single-viewport dashboard.
export type HomeDensity = "comfortable" | "compact";

// Per-viewer Home layout: `order` is the user's preferred full sequence of widget
// ids (a full permutation of the catalog once the user has reordered anything, or
// [] before they have — the HomeScreen falls back to catalog order for any id not
// listed). `hidden` is the set of widget ids the viewer has hidden.
export interface HomeLayout {
  order: string[];
  hidden: string[];
  /** Per-widget size (P3-4: small/medium/large). A widget absent from this map uses
   *  the catalog's default size (see `sizeOf` in homeLayout.ts). */
  sizes: Record<string, WidgetSize>;
}

const THEME_KEY = "dub.ui.theme";
const SIDEBAR_KEY = "dub.ui.sidebar";
const HOME_DENSITY_KEY = "dub.ui.home.density";
const HOME_LAYOUT_KEY = "dub.ui.home.layout";

export interface UiStore {
  sidebarOpen: boolean;
  theme: ThemeValue;
  homeDensity: HomeDensity;
  homeLayout: HomeLayout;
  toggleSidebar(): void;
  setSidebarOpen(open: boolean): void;
  setTheme(t: ThemeValue): void;
  setHomeDensity(d: HomeDensity): void;
  /** Show or hide a single Home widget by id. */
  setHomeWidgetHidden(id: string, hidden: boolean): void;
  /** Replace the full preferred widget order (the HomeScreen computes the merged,
   *  region-aware sequence and commits it here). */
  setHomeWidgetOrder(order: string[]): void;
  /** Set a single Home widget's size (small/medium/large). */
  setHomeWidgetSize(id: string, size: WidgetSize): void;
  /** Restore the default Home dashboard (default order, nothing hidden, comfortable). */
  resetHomeLayout(): void;
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

function readHomeDensity(): HomeDensity {
  try {
    const v = globalThis.localStorage?.getItem(HOME_DENSITY_KEY);
    if (v === "compact" || v === "comfortable") return v;
  } catch {
    /* no storage */
  }
  return "comfortable";
}

function isWidgetSize(v: unknown): v is WidgetSize {
  return v === "small" || v === "medium" || v === "large";
}

function readHomeLayout(): HomeLayout {
  try {
    const raw = globalThis.localStorage?.getItem(HOME_LAYOUT_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const p = parsed as { order?: unknown; hidden?: unknown; sizes?: unknown };
        const order = Array.isArray(p.order) ? p.order.filter((x): x is string => typeof x === "string") : [];
        const hidden = Array.isArray(p.hidden) ? p.hidden.filter((x): x is string => typeof x === "string") : [];
        const sizes: Record<string, WidgetSize> = {};
        if (p.sizes && typeof p.sizes === "object") {
          for (const [id, v] of Object.entries(p.sizes as Record<string, unknown>)) {
            if (isWidgetSize(v)) sizes[id] = v;
          }
        }
        return { order, hidden, sizes };
      }
    }
  } catch {
    /* no storage / malformed */
  }
  return { order: [], hidden: [], sizes: {} };
}

function persist(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* no storage */
  }
}

function persistLayout(layout: HomeLayout): void {
  persist(HOME_LAYOUT_KEY, JSON.stringify(layout));
}

export const useUiStore = create<UiStore>((set, get) => ({
  sidebarOpen: readSidebar(),
  theme: readTheme(),
  homeDensity: readHomeDensity(),
  homeLayout: readHomeLayout(),
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
  setHomeDensity: (d: HomeDensity) => {
    persist(HOME_DENSITY_KEY, d);
    set({ homeDensity: d });
  },
  setHomeWidgetHidden: (id: string, hidden: boolean) => {
    const cur = get().homeLayout;
    const has = cur.hidden.includes(id);
    if (hidden === has) return; // no-op
    const nextHidden = hidden ? [...cur.hidden, id] : cur.hidden.filter((x) => x !== id);
    const next: HomeLayout = { order: cur.order, hidden: nextHidden, sizes: cur.sizes };
    persistLayout(next);
    set({ homeLayout: next });
  },
  setHomeWidgetOrder: (order: string[]) => {
    const cur = get().homeLayout;
    const next: HomeLayout = { order, hidden: cur.hidden, sizes: cur.sizes };
    persistLayout(next);
    set({ homeLayout: next });
  },
  setHomeWidgetSize: (id: string, size: WidgetSize) => {
    const cur = get().homeLayout;
    if (cur.sizes[id] === size) return; // no-op
    const next: HomeLayout = { order: cur.order, hidden: cur.hidden, sizes: { ...cur.sizes, [id]: size } };
    persistLayout(next);
    set({ homeLayout: next });
  },
  resetHomeLayout: () => {
    const next: HomeLayout = { order: [], hidden: [], sizes: {} };
    persistLayout(next);
    persist(HOME_DENSITY_KEY, "comfortable");
    set({ homeLayout: next, homeDensity: "comfortable" });
  },
}));
