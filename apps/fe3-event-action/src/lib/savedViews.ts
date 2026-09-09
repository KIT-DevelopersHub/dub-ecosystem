// Named saved views for the event list filter (P2-2). A "saved view" is a
// user-named snapshot of the current filter, stored as the very same query string
// that filterState.ts already round-trips to the URL (e.g. "phase=open&archived=1").
// Applying a view just replays that query into the URL, so views compose with the
// existing URL-serialized filter with zero new plumbing.
//
// Views are a personal, client-side convenience — they change only what the user
// sees, never stored data — so they live in localStorage (per-browser ≈ per-user):
// $0, no server round-trip, no contract change. This mirrors the fe4 gantt-view-pref
// and fe3 currentEvent conventions (tolerant load/save, garbage coerced to defaults).
//
// The core operations (add/remove/setDefault/coerce) are PURE functions over a
// SavedViewsState value so they unit-test without a DOM; only load/persist touch
// localStorage. The React hook lives in SavedViewsBar.tsx.

export interface SavedView {
  id: string;
  name: string;
  query: string; // serialized EventListFilter, e.g. "phase=open&archived=1" ("" = 全件)
  createdAt: number;
}

export interface SavedViewsState {
  views: SavedView[];
  defaultId: string | null; // the view auto-applied when the list opens with no URL filter
}

const LS_KEY = "fe3:event-saved-views";
const MAX_NAME = 60;
const MAX_VIEWS = 50; // guard against unbounded growth of a personal convenience store

export function emptySavedViews(): SavedViewsState {
  return { views: [], defaultId: null };
}

function genId(): string {
  return `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Add a view (or overwrite the query of an existing view with the same name), pure.
 *  Empty names are ignored; the store is capped at MAX_VIEWS. `opts.makeDefault`
 *  marks the added/updated view as the default. `opts.id`/`opts.now` are for tests. */
export function addView(
  state: SavedViewsState,
  name: string,
  query: string,
  opts?: { id?: string; now?: number; makeDefault?: boolean },
): SavedViewsState {
  const trimmed = name.trim().slice(0, MAX_NAME);
  if (!trimmed) return state;
  const now = opts?.now ?? Date.now();
  const existing = state.views.find((v) => v.name === trimmed);
  let views: SavedView[];
  let targetId: string;
  if (existing) {
    targetId = existing.id;
    views = state.views.map((v) => (v.id === existing.id ? { ...v, query, createdAt: now } : v));
  } else {
    if (state.views.length >= MAX_VIEWS) return state;
    targetId = opts?.id ?? genId();
    views = [...state.views, { id: targetId, name: trimmed, query, createdAt: now }];
  }
  return { views, defaultId: opts?.makeDefault ? targetId : state.defaultId };
}

/** Remove a view; clears the default if it pointed at the removed view. Pure. */
export function removeView(state: SavedViewsState, id: string): SavedViewsState {
  return {
    views: state.views.filter((v) => v.id !== id),
    defaultId: state.defaultId === id ? null : state.defaultId,
  };
}

/** Set (or clear, with null) the default view. Ignores unknown ids. Pure. */
export function setDefault(state: SavedViewsState, id: string | null): SavedViewsState {
  if (id !== null && !state.views.some((v) => v.id === id)) return state;
  return { ...state, defaultId: id };
}

/** The query string of the default view, or null when there is no (valid) default. */
export function defaultQuery(state: SavedViewsState): string | null {
  if (!state.defaultId) return null;
  const v = state.views.find((x) => x.id === state.defaultId);
  return v ? v.query : null;
}

/** Coerce arbitrary parsed JSON into a valid state — bad rows are dropped and a
 *  dangling defaultId falls back to null, so a partial/garbage payload never throws. */
export function coerceSavedViews(raw: unknown): SavedViewsState {
  if (!raw || typeof raw !== "object") return emptySavedViews();
  const obj = raw as { views?: unknown; defaultId?: unknown };
  const views: SavedView[] = Array.isArray(obj.views)
    ? obj.views
        .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
        .map((v) => ({
          id: typeof v.id === "string" ? v.id : "",
          name: typeof v.name === "string" ? v.name.slice(0, MAX_NAME) : "",
          query: typeof v.query === "string" ? v.query : "",
          createdAt: typeof v.createdAt === "number" ? v.createdAt : 0,
        }))
        .filter((v) => v.id !== "" && v.name !== "")
        .slice(0, MAX_VIEWS)
    : [];
  const defaultId =
    typeof obj.defaultId === "string" && views.some((v) => v.id === obj.defaultId)
      ? obj.defaultId
      : null;
  return { views, defaultId };
}

/** Read the saved state (defaults when nothing/garbage stored); tolerant of no/blocked storage. */
export function loadSavedViews(): SavedViewsState {
  try {
    const s = globalThis.localStorage?.getItem(LS_KEY);
    if (s == null) return emptySavedViews();
    return coerceSavedViews(JSON.parse(s));
  } catch {
    return emptySavedViews();
  }
}

/** Persist the state; silently no-ops when storage is unavailable (private mode / quota). */
export function persistSavedViews(state: SavedViewsState): void {
  try {
    globalThis.localStorage?.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    /* storage blocked — the in-memory state still applies */
  }
}
