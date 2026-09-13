// UI state store (Zustand) — FE2 is the ONLY unit allowed a global store.
// Theme is FE2's source of truth (localStorage "dub.ui.theme"); FE1 ThemeProvider
// is controlled and receives this value. Sidebar persists to "dub.ui.sidebar".
//
// It is also the persisted receptacle for the Home dashboard's customizable
// widget grid (each widget's cell position + small/medium/large size — see
// shell/screens/dashboard/homeGrid.ts for the placement engine itself). Persists
// to "dub.ui.home.grid" so a viewer's arrangement survives reload. Which widgets
// are shown at all (add/remove, edit mode only) is a separate map persisted to
// "dub.ui.home.gridHidden" — removing a widget keeps its position/size intact so
// re-adding it restores the old spot rather than a fresh pack.
import { create } from "zustand";
import { isWidgetSize, type WidgetSize } from "../shell/screens/dashboard/homeGrid.ts";

export type { WidgetSize };

// FE2 owns the theme source of truth including "system" (@dub/ui ThemeProvider is
// controlled and only accepts the resolved "light"|"dark"; AppRoot resolves "system").
export type ThemeValue = "light" | "dark" | "system";

export interface HomeGridPrefs {
  positions: Record<string, { x: number; y: number }>;
  sizes: Record<string, WidgetSize>;
}

const THEME_KEY = "dub.ui.theme";
const SIDEBAR_KEY = "dub.ui.sidebar";
const HOME_GRID_KEY = "dub.ui.home.grid";
const HOME_GRID_EDIT_MODE_KEY = "dub.ui.home.gridEditMode";
const HOME_GRID_HIDDEN_KEY = "dub.ui.home.gridHidden";

const EMPTY_HOME_GRID: HomeGridPrefs = { positions: {}, sizes: {} };

export interface UiStore {
  sidebarOpen: boolean;
  theme: ThemeValue;
  homeGrid: HomeGridPrefs;
  /** Whether the Home widget grid is currently editable (drag/resize UI shown,
   *  react-grid-layout dragging enabled). Defaults to false (normal/static
   *  mode) on first-ever load; once toggled, persists across reloads so a
   *  viewer mid-rearrange doesn't get bounced back to static on refresh. */
  homeGridEditMode: boolean;
  /** Widget ids the viewer has explicitly removed from the grid (edit mode's ×
   *  button). Distinct from a widget being absent from `catalog`/`nodes` (no data
   *  to show yet, e.g. "最近開いた" before any visit) — a hidden id's stored
   *  position/size are kept untouched so re-adding it restores its old spot. */
  homeGridHidden: string[];
  toggleSidebar(): void;
  setSidebarOpen(open: boolean): void;
  setTheme(t: ThemeValue): void;
  /** Bulk-set widget positions after a drag settles (react-grid-layout hands back
   *  the FULL, already-reflowed layout on every drag/resize stop). Merges into the
   *  existing position map rather than replacing it wholesale. */
  setHomeGridPositions(items: { id: string; x: number; y: number }[]): void;
  /** Change one widget's size (小/中/大). Position is left alone; the grid engine
   *  re-derives a valid on-screen spot (clamped, then reflowed) on next render. */
  setHomeWidgetSize(id: string, size: WidgetSize): void;
  /** Restore the default (never-customized) Home widget arrangement. */
  resetHomeGrid(): void;
  /** Enter/exit the Home widget grid's edit mode (drag handle + size control
   *  become visible/active only while true). */
  setHomeGridEditMode(editing: boolean): void;
  /** Remove a widget from the grid (edit mode's × button). Idempotent. */
  hideHomeWidget(id: string): void;
  /** Restore a previously-removed widget to the grid ("ウィジェットを追加"). Idempotent. */
  showHomeWidget(id: string): void;
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

function isPosition(v: unknown): v is { x: number; y: number } {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as { x?: unknown }).x === "number" &&
    typeof (v as { y?: unknown }).y === "number"
  );
}

function readHomeGrid(): HomeGridPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(HOME_GRID_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const p = parsed as { positions?: unknown; sizes?: unknown };
        const positions: Record<string, { x: number; y: number }> = {};
        if (p.positions && typeof p.positions === "object") {
          for (const [id, v] of Object.entries(p.positions as Record<string, unknown>)) {
            if (isPosition(v)) positions[id] = v;
          }
        }
        const sizes: Record<string, WidgetSize> = {};
        if (p.sizes && typeof p.sizes === "object") {
          for (const [id, v] of Object.entries(p.sizes as Record<string, unknown>)) {
            if (isWidgetSize(v)) sizes[id] = v;
          }
        }
        return { positions, sizes };
      }
    }
  } catch {
    /* no storage / malformed */
  }
  return { positions: {}, sizes: {} };
}

function persist(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* no storage */
  }
}

function persistHomeGrid(prefs: HomeGridPrefs): void {
  persist(HOME_GRID_KEY, JSON.stringify(prefs));
}

function readHomeGridEditMode(): boolean {
  try {
    // Absence of the key (first-ever load, or a viewer who never entered edit
    // mode) MUST resolve to false — normal/static is the default, not opt-out.
    return globalThis.localStorage?.getItem(HOME_GRID_EDIT_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

function readHomeGridHidden(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(HOME_GRID_HIDDEN_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

function persistHomeGridHidden(hidden: string[]): void {
  persist(HOME_GRID_HIDDEN_KEY, JSON.stringify(hidden));
}

export const useUiStore = create<UiStore>((set, get) => ({
  sidebarOpen: readSidebar(),
  theme: readTheme(),
  homeGrid: readHomeGrid(),
  homeGridEditMode: readHomeGridEditMode(),
  homeGridHidden: readHomeGridHidden(),
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
  setHomeGridPositions: (items: { id: string; x: number; y: number }[]) => {
    const cur = get().homeGrid;
    const positions = { ...cur.positions };
    for (const it of items) positions[it.id] = { x: it.x, y: it.y };
    const next: HomeGridPrefs = { positions, sizes: cur.sizes };
    persistHomeGrid(next);
    set({ homeGrid: next });
  },
  setHomeWidgetSize: (id: string, size: WidgetSize) => {
    const cur = get().homeGrid;
    if (cur.sizes[id] === size) return; // no-op
    const next: HomeGridPrefs = { positions: cur.positions, sizes: { ...cur.sizes, [id]: size } };
    persistHomeGrid(next);
    set({ homeGrid: next });
  },
  resetHomeGrid: () => {
    persistHomeGrid(EMPTY_HOME_GRID);
    set({ homeGrid: { positions: {}, sizes: {} } });
  },
  setHomeGridEditMode: (editing: boolean) => {
    persist(HOME_GRID_EDIT_MODE_KEY, editing ? "1" : "0");
    set({ homeGridEditMode: editing });
  },
  hideHomeWidget: (id: string) => {
    const cur = get().homeGridHidden;
    if (cur.includes(id)) return; // no-op
    const next = [...cur, id];
    persistHomeGridHidden(next);
    set({ homeGridHidden: next });
  },
  showHomeWidget: (id: string) => {
    const cur = get().homeGridHidden;
    if (!cur.includes(id)) return; // no-op
    const next = cur.filter((v) => v !== id);
    persistHomeGridHidden(next);
    set({ homeGridHidden: next });
  },
}));
