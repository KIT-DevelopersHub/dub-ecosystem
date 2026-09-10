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
