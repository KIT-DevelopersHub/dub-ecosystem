// Build the `GET /identity/users` request params from UI filter state.
//
// The frozen `identity.ListUsersQuery` carries { ids?, cursor?, limit? }. The FE7
// design also filters by free-text search + status + roleKey; those ride as extra
// query params (identity-roster accepts them; the frozen type is the guaranteed
// subset). We emit only DEFINED params — empty filters must not appear in the URL
// (design test: "フィルタ組合せが ListUsersQuery に正しく反映").
import type { identity } from "@dub/types";

export type UserStatusFilter = identity.UserStatus | "all";

export interface UserListFilters {
  search: string;
  status: UserStatusFilter;
  roleKey: string | null; // PermissionKey-ish role filter; null = no filter
  cursor?: string;
  limit?: number;
}

// Request a full page (identity-roster clamps to MAX_LIMIT=200) rather than leaving the
// backend DEFAULT_LIMIT=50. Two reasons: (1) so a 50人規模の org loads its whole roster in
// one page and the DataTable's 仮想スクロール (>= threshold 50) actually engages — with the
// default 50-row page it would sit exactly at the boundary; (2) fewer LoadMore round-trips.
// Windowing keeps the DOM bounded regardless of how many rows are loaded.
const ROSTER_PAGE_LIMIT = 200;

export const DEFAULT_USER_FILTERS: UserListFilters = {
  search: "",
  status: "all",
  roleKey: null,
  limit: ROSTER_PAGE_LIMIT,
};

export type ListUsersParams = Record<string, string | number>;

/** Serialize filters to request params, omitting empty/"all"/null values. */
export function buildListUsersParams(filters: UserListFilters): ListUsersParams {
  const params: ListUsersParams = {};
  const search = filters.search.trim();
  if (search.length > 0) params.q = search;
  if (filters.status !== "all") params.status = filters.status;
  if (filters.roleKey) params.roleKey = filters.roleKey;
  if (filters.cursor) params.cursor = filters.cursor;
  if (typeof filters.limit === "number") params.limit = filters.limit;
  return params;
}

/** The frozen-contract subset actually typed by identity.ListUsersQuery. */
export function toListUsersQuery(filters: UserListFilters): identity.ListUsersQuery {
  const q: identity.ListUsersQuery = {};
  if (filters.cursor) q.cursor = filters.cursor;
  if (typeof filters.limit === "number") q.limit = filters.limit;
  return q;
}
