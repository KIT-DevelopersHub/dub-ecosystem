// Measures a CSS Grid container's LIVE column count (mixed-size widget swap redesign
// — see homeLayout.ts module doc). The kpi/side regions' column count changes across
// responsive breakpoints (kpi: 6 → 3 → 2; side: 2 → 1), so a hardcoded "columns" value
// would silently diverge from what the browser actually renders on a narrower viewport
// and mis-simulate `computeDensePositions`/`computeBlocks`. Reading the container's own
// `getComputedStyle(...).gridTemplateColumns` keeps the swap simulation and the
// browser's real layout as the SAME source of truth at every width.
import { useEffect, useRef, useState, type RefObject } from "react";

export function useGridColumns(fallback: number): { ref: RefObject<HTMLDivElement>; columns: number } {
  const ref = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(fallback);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window === "undefined" || typeof window.getComputedStyle !== "function") return;
    const measure = (): void => {
      const tracks = window
        .getComputedStyle(el)
        .gridTemplateColumns.split(" ")
        .filter((t) => t.trim().length > 0);
      if (tracks.length > 0) setColumns(tracks.length);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // Re-attach whenever the container node itself changes; the ResizeObserver
    // already re-measures on every viewport/layout change in between.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.current]);

  return { ref, columns };
}
