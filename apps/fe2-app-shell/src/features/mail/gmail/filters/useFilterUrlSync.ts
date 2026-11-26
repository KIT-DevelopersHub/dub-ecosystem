// Keeps the #899 filters in the URL query (?read=unread&from=…) so a reload or a shared link
// opens the same filtered list. Reads once on mount, then mirrors every change with
// replaceState (no history entry per click), leaving other params such as ?open= alone.
import { useEffect, useRef } from "react";
import { useMailStore } from "../useMailStore.tsx";
import { filterKey, filtersActive, parseFilters, writeFilters } from "./mailFilters.ts";

const location = (): Location | null => (typeof window === "undefined" ? null : window.location);

export function useFilterUrlSync(): void {
  const { state, dispatch } = useMailStore();
  // Filter key the store must reach before the URL is written ("" = ready; null = not mounted).
  // Without it the first write would see the store's empty filters and wipe the URL.
  const awaiting = useRef<string | null>(null);
  useEffect(() => {
    const loc = location();
    if (!loc) return;
    const initial = parseFilters(loc.search);
    if (filtersActive(initial)) {
      awaiting.current = filterKey(initial);
      dispatch({ type: "SET_FILTERS", filters: initial });
    } else awaiting.current = "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const loc = location();
    if (!loc || awaiting.current === null) return;
    if (awaiting.current !== "") {
      if (filterKey(state.filters) !== awaiting.current) return;
      awaiting.current = "";
    }
    const search = writeFilters(loc.search, state.filters);
    if (search === loc.search) return;
    try {
      window.history.replaceState(window.history.state, "", `${loc.pathname}${search}${loc.hash}`);
    } catch {
      /* sandboxed frames may refuse; the filters still apply in-page */
    }
  }, [state.filters]);
}
