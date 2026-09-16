// Pure layout + packing logic for the Home dashboard's customizable widget grid.
//
// This REPLACES the earlier region-scoped "sortable list" design (rejected three
// times in a row: feat/home-widget-dnd, -dnd-v2, -area-swap). That design permuted
// widget ORDER inside a fixed CSS grid per region — it could never place a widget
// at an arbitrary cell, and "collision avoidance" was really just a label swap
// between two positions. It was the wrong MODEL, not a bug to patch further.
//
// The model here is the one specified directly by the product owner: the
// placement area is computed as a GRID OF CELLS (backed by react-grid-layout).
// Each widget declares its footprint in CELLS — 小=1x2, 中=2x2 (the owner's own
// examples; 大=3x3 extends the same +1 col/+1 row step) — and dragging a widget
// over another's cells pushes the other one down the column via the grid engine's
// real vertical compaction. This module has NO React/DOM dependency so the
// packing/no-overlap invariants are unit-testable without a browser.

export const HOME_GRID_COLS_WIDE = 6;
export const HOME_GRID_COLS_NARROW = 2;
// Container width (px) below which the grid drops to a narrow (2-col) layout —
// matches the point at which a 6-col grid's cells would otherwise get too thin to
// hold real content (mirrors the dashboard's other narrow-layout breakpoints).
export const HOME_GRID_NARROW_BREAKPOINT = 640;
export const HOME_GRID_ROW_HEIGHT = 90;
export const HOME_GRID_MARGIN: [number, number] = [16, 16];

export const WIDGET_SIZES = ["small", "medium", "large"] as const;
export type WidgetSize = (typeof WIDGET_SIZES)[number];

// Cell footprint per size. 小/中 are the product owner's own examples; 大 extends
// the same proportional step so the three sizes are visually distinct.
export const SIZE_SPAN: Record<WidgetSize, { w: number; h: number }> = {
  small: { w: 1, h: 2 },
  medium: { w: 2, h: 2 },
  large: { w: 3, h: 3 },
};

export function isWidgetSize(v: unknown): v is WidgetSize {
  return v === "small" || v === "medium" || v === "large";
}

export function nextSize(size: WidgetSize): WidgetSize {
  const i = WIDGET_SIZES.indexOf(size);
  const next = WIDGET_SIZES[(i + 1) % WIDGET_SIZES.length];
  return next ?? "small";
}

/** Column count for a measured container width — a real container-size query
 *  (via ResizeObserver at the call site), not the window's viewport width, so
 *  the grid narrows correctly whether the SHELL sidebar or the page width is
 *  what actually shrank the available space. */
export function colsForWidth(containerWidth: number): number {
  return containerWidth > 0 && containerWidth < HOME_GRID_NARROW_BREAKPOINT
    ? HOME_GRID_COLS_NARROW
    : HOME_GRID_COLS_WIDE;
}

export interface GridWidgetMeta {
  id: string;
  label: string;
  /** Size a widget starts at before the viewer has ever chosen one. Defaults to "small". */
  defaultSize?: WidgetSize;
}

export interface GridItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Persisted viewer preferences: where each widget's top-left cell is (in the
 *  canonical WIDE column space — layoutFor re-derives the narrow layout by
 *  clamping, it never persists a second narrow-specific position) and each
 *  widget's chosen size. A widget absent from either map has not been touched
 *  yet and falls back to its catalog default / gets freshly packed. */
export interface HomeGridPrefs {
  positions: Record<string, { x: number; y: number }>;
  sizes: Record<string, WidgetSize>;
}

export function sizeOf(catalog: GridWidgetMeta[], sizes: Record<string, WidgetSize>, id: string): WidgetSize {
  const stored = sizes[id];
  if (isWidgetSize(stored)) return stored;
  const meta = catalog.find((w) => w.id === id);
  return meta?.defaultSize ?? "small";
}

/** A widget's cell footprint at a given column count, clamped so it never asks
 *  for more columns than the grid actually has (大=3 cols on a 2-col narrow grid
 *  becomes a full-width 2-col item instead of overflowing/being cut off). */
export function effectiveSpan(size: WidgetSize, cols: number): { w: number; h: number } {
  const span = SIZE_SPAN[size];
  return { w: Math.max(1, Math.min(span.w, cols)), h: span.h };
}

interface PackInput {
  id: string;
  w: number;
  h: number;
}

/** Greedily place `items` (in order) into the first free top-left-most cell of a
 *  `cols`-wide grid, treating `occupied` as already-filled cells (mutated as
 *  items are placed). Deterministic: the same input always yields the same
 *  layout, which is what makes the untouched-default dashboard and "reset to
 *  default" reproducible. */
function packInto(items: PackInput[], cols: number, occupied: Set<string> = new Set()): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const key = (x: number, y: number): string => `${x},${y}`;
  const fits = (x: number, y: number, w: number, h: number): boolean => {
    if (x + w > cols) return false;
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        if (occupied.has(key(x + dx, y + dy))) return false;
      }
    }
    return true;
  };
  const occupy = (x: number, y: number, w: number, h: number): void => {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        occupied.add(key(x + dx, y + dy));
      }
    }
  };
  for (const item of items) {
    let placed = false;
    for (let y = 0; !placed && y < 2000; y++) {
      for (let x = 0; x <= cols - 1 && !placed; x++) {
        if (fits(x, y, item.w, item.h)) {
          out.set(item.id, { x, y });
          occupy(x, y, item.w, item.h);
          placed = true;
        }
      }
    }
  }
  return out;
}

/** Default packed layout for the given catalog+sizes at `cols` columns — top-left
 *  to bottom-right in catalog order, with no gaps or overlaps. Used for a
 *  first-ever render (no stored prefs yet) and for "configuration をリセット". */
export function defaultLayout(catalog: GridWidgetMeta[], sizes: Record<string, WidgetSize>, cols: number): GridItem[] {
  const items: PackInput[] = catalog.map((w) => {
    const span = effectiveSpan(sizeOf(catalog, sizes, w.id), cols);
    return { id: w.id, w: span.w, h: span.h };
  });
  const placed = packInto(items, cols);
  return catalog.map((w) => {
    const span = effectiveSpan(sizeOf(catalog, sizes, w.id), cols);
    const pos = placed.get(w.id) ?? { x: 0, y: 0 };
    return { i: w.id, x: pos.x, y: pos.y, w: span.w, h: span.h };
  });
}

/** The full grid layout to render: the viewer's stored position for any widget
 *  that has one (clamped to fit `cols`), and a freshly packed spot — appended
 *  after everything already placed, never overlapping it — for any catalog
 *  widget with no stored position (a brand-new FE3-7 homeWidget the viewer has
 *  never arranged, or the very first render). A widget no longer in `catalog`
 *  (hidden, or a conditional card like "最近開いた" with nothing to show yet)
 *  simply does not appear; its stored prefs stay in storage in case it returns. */
export function layoutFor(catalog: GridWidgetMeta[], prefs: HomeGridPrefs, cols: number): GridItem[] {
  const occupied = new Set<string>();
  const key = (x: number, y: number): string => `${x},${y}`;
  const fitsAt = (x: number, y: number, w: number, h: number): boolean => {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        if (occupied.has(key(x + dx, y + dy))) return false;
      }
    }
    return true;
  };
  const occupy = (x: number, y: number, w: number, h: number): void => {
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) occupied.add(key(x + dx, y + dy));
    }
  };
  const placed: GridItem[] = [];
  const unplaced: GridWidgetMeta[] = [];

  for (const w of catalog) {
    const span = effectiveSpan(sizeOf(catalog, prefs.sizes, w.id), cols);
    const pos = prefs.positions[w.id];
    if (pos) {
      const x = Math.max(0, Math.min(Math.round(pos.x), cols - span.w));
      // Two widgets can independently claim a stored position that no longer
      // fits together once a size changes (e.g. a widget grows from 中 to 大
      // while its neighbour never moved) — a real gap this function must close
      // itself, since THIS array is what seeds react-grid-layout's initial
      // render, before any drag of its own would trigger the library's live
      // compaction. Resolve it the same way a real drag would: keep the
      // widget's column, but push it DOWN to the first row (>= its stored row)
      // that is actually free, in stable catalog order.
      let y = Math.max(0, Math.round(pos.y));
      while (!fitsAt(x, y, span.w, span.h)) y++;
      placed.push({ i: w.id, x, y, w: span.w, h: span.h });
      occupy(x, y, span.w, span.h);
    } else {
      unplaced.push(w);
    }
  }

  const packedUnplaced = packInto(
    unplaced.map((w) => {
      const span = effectiveSpan(sizeOf(catalog, prefs.sizes, w.id), cols);
      return { id: w.id, w: span.w, h: span.h };
    }),
    cols,
    occupied,
  );
  for (const w of unplaced) {
    const span = effectiveSpan(sizeOf(catalog, prefs.sizes, w.id), cols);
    const pos = packedUnplaced.get(w.id) ?? { x: 0, y: 0 };
    placed.push({ i: w.id, x: pos.x, y: pos.y, w: span.w, h: span.h });
  }

  // Stable catalog order for deterministic output (tests, snapshots).
  const rank = new Map(catalog.map((w, idx) => [w.id, idx]));
  placed.sort((a, b) => (rank.get(a.i) ?? 0) - (rank.get(b.i) ?? 0));
  return placed;
}

/** True if any two items in `items` overlap. Used by tests to assert the packing
 *  invariant (and reusable by a live sanity-check if ever needed). */
export function hasOverlap(items: GridItem[]): boolean {
  for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length; b++) {
      const p = items[a]!;
      const q = items[b]!;
      const overlapX = p.x < q.x + q.w && q.x < p.x + p.w;
      const overlapY = p.y < q.y + q.h && q.y < p.y + p.h;
      if (overlapX && overlapY) return true;
    }
  }
  return false;
}
