// Client-side sort for the roster table (⑤ 列ソート). The roster list is a cursor
// page; sorting reorders the ROWS ALREADY LOADED (the demo/mock returns the full
// set in one page, so this sorts the whole roster there). Pure + deterministic so
// it is unit-testable and stable (equal keys keep their original order).
import type { SortState } from "@dub/ui";
import type { RosterUser } from "../contracts/pending";

/** Columns the roster table allows sorting on. Complex cells (運営メンバー・ロール)
 *  are intentionally excluded — they render composite widgets, not a scalar key. */
export type SortableUserKey = "name" | "email" | "source" | "status";

export const SORTABLE_USER_KEYS: readonly SortableUserKey[] = ["name", "email", "source", "status"];

export function isSortableUserKey(key: string): key is SortableUserKey {
  return (SORTABLE_USER_KEYS as readonly string[]).includes(key);
}

// Meaningful status order (在籍 → 招待中 → 停止 → 却下) so an ascending sort reads
// as a lifecycle, not alphabetical noise.
const STATUS_RANK: Record<string, number> = { active: 0, invited: 1, disabled: 2, rejected: 3 };

function sourceLabel(u: RosterUser): string {
  return u.source === "email-routing" ? "0" : "1"; // Email Routing first when asc
}

function compareBy(key: SortableUserKey, a: RosterUser, b: RosterUser): number {
  switch (key) {
    case "name":
      return a.displayName.localeCompare(b.displayName, "ja");
    case "email":
      return a.email.localeCompare(b.email, "ja");
    case "source":
      return sourceLabel(a).localeCompare(sourceLabel(b));
    case "status": {
      const ra = STATUS_RANK[a.status] ?? 99;
      const rb = STATUS_RANK[b.status] ?? 99;
      return ra - rb;
    }
  }
}

/** Return a new array sorted per `sort`. Unknown/empty sort returns the input order
 *  (a shallow copy so callers can rely on referential change-free identity when unsorted). */
export function sortUsers(rows: readonly RosterUser[], sort: SortState | undefined): RosterUser[] {
  if (!sort || !isSortableUserKey(sort.key)) return [...rows];
  const dir = sort.direction === "desc" ? -1 : 1;
  // Decorate-sort-undecorate to keep the sort STABLE (Array.sort is stable in modern
  // engines, but tie-break on original index makes it explicit + engine-independent).
  return rows
    .map((row, index) => ({ row, index }))
    .sort((x, y) => {
      const c = compareBy(sort.key as SortableUserKey, x.row, y.row);
      return c !== 0 ? c * dir : x.index - y.index;
    })
    .map((d) => d.row);
}
