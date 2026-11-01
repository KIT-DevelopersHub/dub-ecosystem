// Filter an already-loaded list in memory — no request per keystroke.
// The term is deferred (useDeferredValue) so typing stays responsive on big lists,
// and matching is a normalized substring test (same shape as the server's LIKE):
// trim, NFKC (全角→半角), lowercase, カタカナ→ひらがな.
import { useDeferredValue, useMemo } from "react";

const KATAKANA = /[ァ-ヶ]/g;

/** Normalize text for search matching. */
export function normalizeSearchText(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(KATAKANA, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .trim();
}

/** True when the normalized `term` is a substring of the normalized `text` (empty term matches). */
export function matchesSearch(text: string, term: string): boolean {
  return normalizeSearchText(text).includes(normalizeSearchText(term));
}

export interface ClientFilter<T> {
  /** Items matching the (deferred) term; the input array itself when the term is empty. */
  results: readonly T[];
  /** True while the rendered results lag behind the latest term. */
  isStale: boolean;
}

/**
 * @param getText searchable text of an item (join several fields with a space).
 *   Keep it stable (module-level or useCallback) so the index isn't rebuilt each render.
 */
export function useClientFilter<T>(
  items: readonly T[],
  term: string,
  getText: (item: T) => string,
): ClientFilter<T> {
  const deferred = useDeferredValue(term);
  const index = useMemo(() => items.map((it) => normalizeSearchText(getText(it))), [items, getText]);
  const results = useMemo(() => {
    const needle = normalizeSearchText(deferred);
    if (!needle) return items;
    return items.filter((_, i) => (index[i] ?? "").includes(needle));
  }, [items, index, deferred]);
  return { results, isStale: deferred !== term };
}
