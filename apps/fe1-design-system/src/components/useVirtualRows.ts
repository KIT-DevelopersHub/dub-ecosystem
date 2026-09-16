import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Zero-dependency row windowing for long tables/lists. Renders only the rows
 * inside the scroll viewport (+ overscan) so a 数百〜数千行 list stays smooth
 * (no O(n) DOM on first paint, no per-row work for off-screen rows).
 *
 * Design notes:
 * - Variable-height safe: each rendered row reports its real height via
 *   `measureElement`; offsets are prefix-summed from those measurements and fall
 *   back to `estimateRowHeight` for not-yet-measured rows. Uniform rows just work.
 * - Progressive enhancement: when the viewport height can't be measured (SSR /
 *   jsdom, no ResizeObserver), `active` is false and callers render every row —
 *   so tables stay fully accessible and testable without a real layout engine.
 * - Cheap scroll: offsets are cached and only rebuilt when count / estimate /
 *   measurements change; scrolling is a binary search + slice.
 */
export interface UseVirtualRowsOptions {
  /** Total number of rows in the full (unwindowed) list. */
  count: number;
  /** Approx row height (px) for not-yet-measured rows + initial window. */
  estimateRowHeight: number;
  /** Rows rendered above/below the viewport to cushion fast scrolls. */
  overscan?: number;
  /** Returns the scroll container element (stable getter). */
  getScrollElement: () => HTMLElement | null;
  /** Master switch; when false the hook is inert and reports `active: false`. */
  enabled?: boolean;
  /** Viewport height (px) to assume before the first real measurement, so
   *  windowing engages on the first browser paint instead of rendering all rows
   *  once. Ignored in environments without ResizeObserver. */
  initialViewport?: number;
}

export interface VirtualRowsResult {
  /** First row index to render (inclusive). */
  startIndex: number;
  /** Last row index to render (inclusive). */
  endIndex: number;
  /** Spacer height (px) standing in for the rows above `startIndex`. */
  paddingTop: number;
  /** Spacer height (px) standing in for the rows below `endIndex`. */
  paddingBottom: number;
  /** Total scrollable height (px) of the full list. */
  totalSize: number;
  /** True when windowing is live (viewport measured / assumed). When false,
   *  callers should render every row unchanged. */
  active: boolean;
  /** Ref callback for a rendered row — records its real height for accuracy. */
  measureElement: (index: number, el: HTMLElement | null) => void;
}

const hasResizeObserver = typeof ResizeObserver !== "undefined";

/** Largest i in [0, n] with offsets[i] <= target (clamped). */
function findRow(offsets: number[], target: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid]! <= target) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function useVirtualRows(opts: UseVirtualRowsOptions): VirtualRowsResult {
  const { count, estimateRowHeight, overscan = 8, getScrollElement, enabled = true, initialViewport = 0 } = opts;

  const measuredRef = useRef<Map<number, number>>(new Map());
  const [scrollTop, setScrollTop] = useState(0);
  // Assume the caller's viewport before the first real measurement so a browser
  // windows on first paint; jsdom/SSR (no ResizeObserver) start at 0 → render-all.
  const [viewport, setViewport] = useState(() => (hasResizeObserver ? initialViewport : 0));
  // Bumped whenever a measurement changes so offsets rebuild.
  const [measureTick, setMeasureTick] = useState(0);

  // Prefix-summed row offsets (rebuilt only when count/estimate/measurements move).
  const { offsets, totalSize } = useMemo(() => {
    const offs = new Array<number>(count + 1);
    offs[0] = 0;
    for (let i = 0; i < count; i++) {
      offs[i + 1] = offs[i]! + (measuredRef.current.get(i) ?? estimateRowHeight);
    }
    return { offsets: offs, totalSize: count > 0 ? offs[count]! : 0 };
    // measureTick intentionally participates so measurements refresh offsets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, estimateRowHeight, measureTick]);

  useEffect(() => {
    if (!enabled) return;
    const el = getScrollElement();
    if (!el) return;
    const onScroll = () => setScrollTop(el.scrollTop);
    const measure = () => setViewport(el.clientHeight);
    measure();
    setScrollTop(el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    let ro: ResizeObserver | undefined;
    if (hasResizeObserver) {
      ro = new ResizeObserver(measure);
      ro.observe(el);
    }
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
    };
  }, [enabled, getScrollElement]);

  const active = enabled && viewport > 0 && count > 0;

  const range = useMemo(() => {
    if (!active) {
      return { startIndex: 0, endIndex: Math.max(0, count - 1), paddingTop: 0, paddingBottom: 0 };
    }
    const first = findRow(offsets, scrollTop);
    const last = findRow(offsets, scrollTop + viewport);
    const startIndex = Math.max(0, first - overscan);
    const endIndex = Math.min(count - 1, last + overscan);
    return {
      startIndex,
      endIndex,
      paddingTop: offsets[startIndex]!,
      paddingBottom: totalSize - offsets[endIndex + 1]!,
    };
  }, [active, offsets, totalSize, scrollTop, viewport, overscan, count]);

  const measureElement = useCallback((index: number, el: HTMLElement | null) => {
    if (!el) return;
    const h = el.getBoundingClientRect().height;
    if (h > 0 && measuredRef.current.get(index) !== h) {
      measuredRef.current.set(index, h);
      setMeasureTick((t) => t + 1);
    }
  }, []);

  return { ...range, totalSize, active, measureElement };
}
