// Pure layout logic for the customizable Home dashboard (P3-2/P3-3). The HomeScreen
// owns the WIDGET CATALOG (which widgets exist, their region and label) and the
// rendered nodes; this module holds the order/hide RULES so they are unit-testable
// in isolation and shared by the screen's inline 編集モード (HomeEditableRegion).
//
// Widgets live in four fixed regions, each with its own layout: the KPI strip
// (`kpi`), the two side-by-side graph cards (`cards`), the full-width app launchpad
// (`apps`), and the right rail of live panels + feature widgets (`side`). Reordering
// NEVER moves a widget across regions (the layout would break); it only permutes
// within a region. A widget may be hidden in any region.

export const HOME_REGIONS = ["kpi", "cards", "apps", "side"] as const;
export type HomeRegion = (typeof HOME_REGIONS)[number];

// ---- widget size (P3-4: iOS 風 3 サイズ) ------------------------------------------
// Each resizable widget can be small / medium / large, expressed as a CSS Grid span
// (columns x rows) so a region's grid can freely mix sizes and pack the gaps with
// `grid-auto-flow: dense`. Modeled on the iOS ホーム画面ウィジェット 3 段階— small is a
// single cell, medium is a wide single row, large is a big 2x2 block.
export const HOME_WIDGET_SIZES = ["small", "medium", "large"] as const;
export type WidgetSize = (typeof HOME_WIDGET_SIZES)[number];

export const WIDGET_SIZE_SPAN: Record<WidgetSize, { col: number; row: number }> = {
  small: { col: 1, row: 1 },
  medium: { col: 2, row: 1 },
  large: { col: 2, row: 2 },
};

/** CSS Grid span for a widget's effective size, ready to spread into a `style` object.
 *  Only takes effect on an element that is actually a direct child of a CSS Grid
 *  container — harmless (ignored) anywhere else, so it is safe to apply unconditionally
 *  to a widget's own root node regardless of whether the dashboard is resting or being
 *  edited (in 編集モード the true grid item is the SortableList row wrapper instead —
 *  see HomeEditableRegion's `getItemStyle`). */
export function spanStyle(size: WidgetSize): { gridColumn: string; gridRow: string } {
  const s = WIDGET_SIZE_SPAN[size];
  return { gridColumn: `span ${s.col}`, gridRow: `span ${s.row}` };
}

// ---- mixed-size drag swap (postmortem redesign) -----------------------------------
// BACKGROUND (2 rejected fixes — see PR #484 / fix/widget-area-swap-mutual): a region
// mixing small/medium/large widgets renders with `grid-auto-flow: dense` so gaps a
// wide/tall tile leaves get back-filled by smaller tiles later in the id order. Both
// prior attempts ("move" = arrayMove/insert, then "swap" = dnd-kit rectSwappingStrategy
// + arraySwap) operated purely on the FLAT ID ARRAY and assumed "exchange 2 ids in the
// array" <=> "exchange 2 widgets' on-screen rectangles". That equivalence does NOT hold
// under `dense`: the browser's placement algorithm re-derives every widget's actual
// (row, col) from the WHOLE sequence + spans on every reflow, backfilling non-adjacent
// small tiles into gaps left by a wide/tall neighbour — so swapping two array slots can
// silently reshuffle (or fail to move) tiles that were never touched, which is read by a
// real user, dragging with a real mouse, as "sizes different ⇒ can't swap" — even though
// an id-order-only regression test (checking DOM child order, not on-screen geometry)
// keeps passing.
//
// FIX: stop trying to infer the visual effect of an array swap. Instead:
//   1. `computeDensePositions` is a small, exact simulator of the CSS `dense` auto-
//      placement algorithm (scan row-major from the grid origin for the first free
//      cell that fits each item, in order) — for a given id order + column count it
//      returns EXACTLY the (row, col) the browser will paint each widget at.
//   2. `computeBlocks` unions widgets that end up sharing any occupied row into one
//      swappable BLOCK (this is what makes "medium ⇄ 2 small" and "large ⇄ 2 medium"
//      well-defined: the 2 smalls that a `dense` backfill packs into one row together
//      ARE one block, matching what the user actually sees as "this row").
//   3. `swapBlocks` exchanges the ENTIRE block containing the dragged widget with the
//      entire block containing the drop target — never a lone id — and returns the
//      flattened id order. Every OTHER block's ids/relative order are untouched, so
//      re-simulating that new order reproduces "these two rows traded places, nothing
//      else moved" instead of an emergent, order-dependent reshuffle.
//   4. `positionStyle` turns a simulated (row, col) into an EXPLICIT CSS Grid placement
//      (`<line> / span <n>`) so what's rendered is driven by the SAME simulation that
//      decided the swap — not a second, independent pass through the browser's own
//      (also `dense`) auto-placement, which is exactly the two-source-of-truth gap that
//      let the previous fixes diverge from what the user's browser actually painted.

export interface GridSpan {
  col: number;
  row: number;
}

export interface WidgetBlock {
  /** ids grouped into this one swappable row-unit, in their original relative order.
   *  Length 1 for a solo tile (medium/large, or an unpaired "orphan" small); length
   *  ≥2 for a run of small tiles `dense` packs into the same row (possibly a `dense`
   *  backfill of a NON-adjacent small — see computeBlocks). */
  ids: string[];
}

/** Exact simulator of CSS Grid's `dense` auto-placement for a fixed-column-count grid:
 *  for each id (in order), scan cells row-major from (1,1) and place it at the first
 *  cell whose span fits with no overlap — precisely what `grid-auto-flow: dense` does.
 *  Given the same id order + spans + column count, this returns the same (row, col)
 *  the browser will actually paint, so it is the single source of truth for both
 *  "which widgets share a row" (computeBlocks) and "where does each widget render"
 *  (positionStyle) — the previous fixes broke because those two questions were
 *  answered by two DIFFERENT mechanisms (JS array-swap intent vs. the browser's own
 *  independent `dense` pass) that could disagree. */
export function computeDensePositions(
  ids: string[],
  spanOf: (id: string) => GridSpan,
  columns: number,
): Map<string, { row: number; col: number }> {
  const cols = Math.max(1, columns);
  const occupied = new Set<string>();
  const fits = (row: number, col: number, span: GridSpan): boolean => {
    if (col + span.col - 1 > cols) return false;
    for (let r = row; r < row + span.row; r++) {
      for (let c = col; c < col + span.col; c++) {
        if (occupied.has(`${r},${c}`)) return false;
      }
    }
    return true;
  };
  const occupy = (row: number, col: number, span: GridSpan): void => {
    for (let r = row; r < row + span.row; r++) {
      for (let c = col; c < col + span.col; c++) occupied.add(`${r},${c}`);
    }
  };
  const positions = new Map<string, { row: number; col: number }>();
  for (const id of ids) {
    const raw = spanOf(id);
    const span: GridSpan = { col: Math.max(1, Math.min(raw.col, cols)), row: Math.max(1, raw.row) };
    let row = 1;
    // Bounded by ids.length rows-per-item worst case (every item alone on its own
    // row) + a small margin — always terminates; this is a finite occupancy scan,
    // never an infinite loop.
    const maxRow = ids.length * Math.max(1, span.row) + 4;
    outer: for (; row <= maxRow; row++) {
      for (let col = 1; col <= cols - span.col + 1; col++) {
        if (fits(row, col, span)) {
          positions.set(id, { row, col });
          occupy(row, col, span);
          break outer;
        }
      }
    }
    if (!positions.has(id)) positions.set(id, { row: maxRow, col: 1 });
  }
  return positions;
}

/** Group a region's ordered widgets into swappable BLOCKS (see module doc above).
 *  Two widgets land in the same block iff `computeDensePositions` places them so
 *  their occupied rows overlap — this is what makes a `dense` backfill pairing (two
 *  non-adjacent small ids sharing one row) count as ONE unit instead of two. */
export function computeBlocks(ids: string[], spanOf: (id: string) => GridSpan, columns: number): WidgetBlock[] {
  if (ids.length === 0) return [];
  const positions = computeDensePositions(ids, spanOf, columns);
  const parent = new Map<string, string>(ids.map((id) => [id, id]));
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) as string;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const byRow = new Map<number, string[]>();
  for (const id of ids) {
    const pos = positions.get(id);
    if (!pos) continue;
    const span = spanOf(id);
    for (let r = pos.row; r < pos.row + Math.max(1, span.row); r++) {
      const arr = byRow.get(r) ?? [];
      arr.push(id);
      byRow.set(r, arr);
    }
  }
  for (const arr of byRow.values()) {
    const [first, ...rest] = arr;
    if (!first) continue;
    for (const id of rest) union(first, id);
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const root = find(id);
    const arr = groups.get(root) ?? [];
    arr.push(id);
    groups.set(root, arr);
  }
  const minRow = (groupIds: string[]): number =>
    Math.min(...groupIds.map((id) => positions.get(id)?.row ?? Number.POSITIVE_INFINITY));
  return Array.from(groups.values())
    .map((groupIds) => ({ ids: ids.filter((id) => groupIds.includes(id)) }))
    .sort((a, b) => minRow(a.ids) - minRow(b.ids));
}

/** Turn a drop into the region's next full id order by exchanging the ENTIRE block
 *  containing `fromId` with the entire block containing `toId` — never a lone id (see
 *  module doc). Same-block drops (e.g. one small dropped on its own row-mate) swap
 *  just those two ids within the block. Every other block's ids and relative order
 *  are returned byte-for-byte unchanged. Falls back to the original flattened order if
 *  either id can't be located. */
export function swapBlocks(blocks: WidgetBlock[], fromId: string, toId: string): string[] {
  const flat = blocks.flatMap((b) => b.ids);
  if (fromId === toId) return flat;
  const fromIdx = blocks.findIndex((b) => b.ids.includes(fromId));
  const toIdx = blocks.findIndex((b) => b.ids.includes(toId));
  if (fromIdx < 0 || toIdx < 0) return flat;
  const next = blocks.slice();
  if (fromIdx === toIdx) {
    const block = blocks[fromIdx];
    if (!block) return flat;
    const ids = block.ids.slice();
    const a = ids.indexOf(fromId);
    const b = ids.indexOf(toId);
    if (a < 0 || b < 0) return flat;
    const tmp = ids[a] as string;
    ids[a] = ids[b] as string;
    ids[b] = tmp;
    next[fromIdx] = { ids };
    return next.flatMap((bl) => bl.ids);
  }
  const fromBlock = blocks[fromIdx];
  const toBlock = blocks[toIdx];
  if (!fromBlock || !toBlock) return flat;
  next[fromIdx] = toBlock;
  next[toIdx] = fromBlock;
  return next.flatMap((bl) => bl.ids);
}

/** Explicit CSS Grid placement (line-based, not `span`-only) for a widget's simulated
 *  `computeDensePositions` cell — pairs with `spanStyle`'s span but ALSO pins the
 *  start line, so the render is driven by the exact same simulation `computeBlocks`/
 *  `swapBlocks` reasoned about, not a second independent `dense` auto-placement pass
 *  that could disagree with it (see module doc). */
export function positionStyle(pos: { row: number; col: number }, size: WidgetSize): { gridColumn: string; gridRow: string } {
  const s = WIDGET_SIZE_SPAN[size];
  return { gridColumn: `${pos.col} / span ${s.col}`, gridRow: `${pos.row} / span ${s.row}` };
}

export interface HomeWidgetMeta {
  id: string;
  label: string;
  region: HomeRegion;
  /** Whether this widget participates in the small/medium/large size system. A
   *  structural, single-purpose section (the full-width app launchpad, the two fixed
   *  visualization cards) opts out with `false` — it always renders at its own
   *  region-defined size, and the 編集モード size picker is hidden for it. Defaults
   *  to true. */
  resizable?: boolean;
  /** The size a resizable widget starts at before the viewer ever picks one — lets a
   *  region keep its CURRENT look by default (e.g. a side-rail panel defaults to
   *  "medium" = full width, matching the pre-P3-4 stacked layout) while still letting
   *  the viewer size it down. Defaults to "small". */
  defaultSize?: WidgetSize;
}

/** The effective size of a widget: the viewer's stored choice if valid, else the
 *  catalog's `defaultSize` (or "small"). A non-resizable widget always reports
 *  "small" (a 1x1 span — its actual on-screen size is fixed by its own region CSS,
 *  not by this system, so the span is inert for it). */
export function sizeOf(catalog: HomeWidgetMeta[], sizes: Record<string, WidgetSize>, id: string): WidgetSize {
  const meta = catalog.find((w) => w.id === id);
  if (!meta || meta.resizable === false) return "small";
  const stored = sizes[id];
  if (stored === "small" || stored === "medium" || stored === "large") return stored;
  return meta.defaultSize ?? "small";
}

/** Whether a widget takes part in the small/medium/large size system at all. */
export function isResizableWidget(w: HomeWidgetMeta): boolean {
  return w.resizable !== false;
}

/** Rank map from a stored preferred order (id -> position). Ids not present rank
 *  after all listed ids, keeping their catalog-relative order (stable). */
function rankOf(order: string[]): Map<string, number> {
  const m = new Map<string, number>();
  order.forEach((id, i) => {
    if (!m.has(id)) m.set(id, i);
  });
  return m;
}

/** Sort a set of widgets by the user's preferred `order`, falling back to their
 *  position in `catalog` (the default order) for any id not in `order`. Stable. */
export function sortByOrder<T extends { id: string }>(widgets: T[], catalog: HomeWidgetMeta[], order: string[]): T[] {
  const rank = rankOf(order);
  const catIndex = new Map(catalog.map((w, i) => [w.id, i]));
  return widgets
    .map((w, i) => ({ w, i }))
    .sort((a, b) => {
      const ra = rank.get(a.w.id) ?? Number.POSITIVE_INFINITY;
      const rb = rank.get(b.w.id) ?? Number.POSITIVE_INFINITY;
      if (ra !== rb) return ra - rb;
      const ca = catIndex.get(a.w.id) ?? a.i;
      const cb = catIndex.get(b.w.id) ?? b.i;
      return ca - cb;
    })
    .map(({ w }) => w);
}

/** All widgets of a region, INCLUDING hidden ones, in effective order. Used by 編集
 *  モード (you can reorder / toggle every widget, hidden or not). */
export function regionOrdered(catalog: HomeWidgetMeta[], order: string[], region: HomeRegion): HomeWidgetMeta[] {
  return sortByOrder(
    catalog.filter((w) => w.region === region),
    catalog,
    order,
  );
}

/** The VISIBLE widgets of a region in effective order. Used by the dashboard render. */
export function visibleRegion(
  catalog: HomeWidgetMeta[],
  order: string[],
  hidden: string[],
  region: HomeRegion,
): HomeWidgetMeta[] {
  const hiddenSet = new Set(hidden);
  return regionOrdered(catalog, order, region).filter((w) => !hiddenSet.has(w.id));
}

/** Produce the new FULL preferred order after a within-region reorder. Regions are
 *  emitted in their fixed sequence; the changed region uses `newRegionIds`, the
 *  others keep their current effective order — so the result is always a valid full
 *  permutation of the catalog with widgets never crossing regions. */
export function mergeRegionOrder(
  catalog: HomeWidgetMeta[],
  order: string[],
  region: HomeRegion,
  newRegionIds: string[],
): string[] {
  const out: string[] = [];
  for (const r of HOME_REGIONS) {
    if (r === region) {
      out.push(...newRegionIds);
    } else {
      out.push(...regionOrdered(catalog, order, r).map((w) => w.id));
    }
  }
  return out;
}
