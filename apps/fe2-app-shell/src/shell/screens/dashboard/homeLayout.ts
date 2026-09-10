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

export interface HomeWidgetMeta {
  id: string;
  label: string;
  region: HomeRegion;
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
