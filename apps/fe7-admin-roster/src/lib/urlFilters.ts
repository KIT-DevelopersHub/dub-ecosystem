// ⑧ フィルタのURL保存・共有ビュー. The roster's search/status filter + sort live in the
// URL query string, so a narrowed view is bookmarkable / shareable and survives a
// reload (離脱で消えない). Pure serialize/parse helpers + thin window wrappers, guarded
// for SSR / test environments without a real location.
import type { SortState } from "@dub/ui";
import type { UserListFilters, UserStatusFilter } from "./listUsersQuery";
import { DEFAULT_USER_FILTERS } from "./listUsersQuery";
import { isSortableUserKey } from "./sortUsers";

const STATUS_VALUES: readonly UserStatusFilter[] = ["all", "active", "invited", "disabled", "rejected"];

// Only these keys are OWNED by the roster view; everything else in the query string
// (e.g. router-managed params) is left untouched when we write back.
const PARAM_Q = "q";
const PARAM_STATUS = "status";
const PARAM_SORT = "sort";
const PARAM_DIR = "dir";

export interface RosterViewState {
  filters: Pick<UserListFilters, "search" | "status">;
  sort: SortState | undefined;
}

function isStatus(v: string | null): v is UserStatusFilter {
  return v != null && (STATUS_VALUES as readonly string[]).includes(v);
}

/** Parse a query string (e.g. `window.location.search`) into roster view state. */
export function parseRosterView(search: string): RosterViewState {
  const p = new URLSearchParams(search);
  const q = p.get(PARAM_Q) ?? "";
  const statusRaw = p.get(PARAM_STATUS);
  const status: UserStatusFilter = isStatus(statusRaw) ? statusRaw : "all";

  const sortKey = p.get(PARAM_SORT);
  const dir = p.get(PARAM_DIR) === "desc" ? "desc" : "asc";
  const sort: SortState | undefined = sortKey && isSortableUserKey(sortKey) ? { key: sortKey, direction: dir } : undefined;

  return { filters: { search: q, status }, sort };
}

/** Serialize roster view state to a query string, omitting default/empty values so a
 *  pristine view has a clean URL. Preserves any unrelated params from `base`. */
export function serializeRosterView(state: RosterViewState, base = ""): string {
  const p = new URLSearchParams(base);
  const q = state.filters.search.trim();
  if (q) p.set(PARAM_Q, q);
  else p.delete(PARAM_Q);

  if (state.filters.status !== "all") p.set(PARAM_STATUS, state.filters.status);
  else p.delete(PARAM_STATUS);

  if (state.sort) {
    p.set(PARAM_SORT, state.sort.key);
    p.set(PARAM_DIR, state.sort.direction);
  } else {
    p.delete(PARAM_SORT);
    p.delete(PARAM_DIR);
  }
  return p.toString();
}

/** Read the current roster view from the browser URL (defaults when unavailable). */
export function readRosterViewFromUrl(): RosterViewState {
  if (typeof window === "undefined" || !window.location) {
    return { filters: { search: DEFAULT_USER_FILTERS.search, status: DEFAULT_USER_FILTERS.status }, sort: undefined };
  }
  return parseRosterView(window.location.search);
}

/** Replace (never push) the URL query so back/forward isn't polluted by keystrokes.
 *  Only the roster-owned params change; other params in the URL are preserved. */
export function writeRosterViewToUrl(state: RosterViewState): void {
  if (typeof window === "undefined" || !window.history || !window.location) return;
  const query = serializeRosterView(state, window.location.search);
  const next = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  try {
    window.history.replaceState(window.history.state, "", next);
  } catch {
    /* jsdom / sandboxed frames may block history — degrade to in-memory state only */
  }
}
