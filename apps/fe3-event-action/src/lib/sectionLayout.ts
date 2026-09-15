// Pure layout logic for the Event detail page's customizable sections (重要リンク /
// 連絡先 / 概要 / ... — see EventDetailsPanel). Ported from FE2's Home dashboard
// widget layout (homeLayout.ts / P3-2·P3-3) so both apps reorder/hide the SAME way;
// the difference is WHERE the order+hidden set persists: Home is per-viewer
// (localStorage), this is one shared document per event (server, event:write-gated).
//
// Sections live in fixed GROUPS, each a drag-reorder scope. Groups are a finer
// split than EventDetailsPanel's visual headings (概要 / 開催情報 / 当日運営 /
// 運営管理 / 記録・連絡) because two of those headings mix differently-sized
// sections (a narrow field alongside full-width ones) — splitting by width keeps
// every group visually uniform so reordering never needs to resize a row. Two
// headings ("運営管理", "記録・連絡") host two consecutive groups each; see
// EventDetailsPanel for the heading -> group(s) mapping.
// Reordering NEVER moves a section across groups; it only permutes within one. A
// section may be hidden in any group.

export const SECTION_GROUPS = ["overview", "venueInfo", "dayOps", "opsBudget", "opsWide", "recordMemo", "recordNarrow"] as const;
export type SectionGroup = (typeof SECTION_GROUPS)[number];

export interface SectionMeta {
  id: string;
  label: string;
  group: SectionGroup;
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

/** Sort a set of sections by the preferred `order`, falling back to their position in
 *  `catalog` (the default order) for any id not in `order`. Stable. */
export function sortByOrder<T extends { id: string }>(sections: T[], catalog: SectionMeta[], order: string[]): T[] {
  const rank = rankOf(order);
  const catIndex = new Map(catalog.map((s, i) => [s.id, i]));
  return sections
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const ra = rank.get(a.s.id) ?? Number.POSITIVE_INFINITY;
      const rb = rank.get(b.s.id) ?? Number.POSITIVE_INFINITY;
      if (ra !== rb) return ra - rb;
      const ca = catIndex.get(a.s.id) ?? a.i;
      const cb = catIndex.get(b.s.id) ?? b.i;
      return ca - cb;
    })
    .map(({ s }) => s);
}

/** All sections of a group, INCLUDING hidden ones, in effective order. Used by 編集
 *  モード (every section, hidden or not, can be reordered / toggled). */
export function groupOrdered(catalog: SectionMeta[], order: string[], group: SectionGroup): SectionMeta[] {
  return sortByOrder(
    catalog.filter((s) => s.group === group),
    catalog,
    order,
  );
}

/** The VISIBLE sections of a group in effective order. Used by the resting (non-edit)
 *  render. */
export function visibleGroup(
  catalog: SectionMeta[],
  order: string[],
  hidden: string[],
  group: SectionGroup,
): SectionMeta[] {
  const hiddenSet = new Set(hidden);
  return groupOrdered(catalog, order, group).filter((s) => !hiddenSet.has(s.id));
}

/** Produce the new FULL preferred order after a within-group reorder. Groups are
 *  emitted in their fixed sequence; the changed group uses `newGroupIds`, the others
 *  keep their current effective order — so the result is always a valid full
 *  permutation of the catalog with sections never crossing groups. */
export function mergeGroupOrder(
  catalog: SectionMeta[],
  order: string[],
  group: SectionGroup,
  newGroupIds: string[],
): string[] {
  const out: string[] = [];
  for (const g of SECTION_GROUPS) {
    if (g === group) {
      out.push(...newGroupIds);
    } else {
      out.push(...groupOrdered(catalog, order, g).map((s) => s.id));
    }
  }
  return out;
}

/** Move an id to a new index within a list (translate a drop into the group's next id
 *  order). */
export function moveTo(ids: string[], from: number, to: number): string[] {
  if (from < 0 || to < 0 || from === to) return ids;
  const next = ids.slice();
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return ids;
  next.splice(to, 0, moved);
  return next;
}
