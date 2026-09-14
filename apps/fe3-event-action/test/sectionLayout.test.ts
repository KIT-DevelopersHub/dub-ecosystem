import { describe, it, expect } from "vitest";
import {
  SECTION_GROUPS,
  mergeGroupOrder,
  groupOrdered,
  sortByOrder,
  visibleGroup,
  moveTo,
  type SectionMeta,
} from "../src/lib/sectionLayout";

const CATALOG: SectionMeta[] = [
  { id: "overview", label: "概要", group: "overview" },
  { id: "venue", label: "会場", group: "venueInfo" },
  { id: "access", label: "アクセス", group: "venueInfo" },
  { id: "schedule", label: "タイムテーブル", group: "dayOps" },
  { id: "speakers", label: "登壇者", group: "dayOps" },
  { id: "budget", label: "予算", group: "opsBudget" },
  { id: "sponsors", label: "協賛", group: "opsWide" },
  { id: "memo", label: "メモ", group: "recordMemo" },
  { id: "links", label: "リンク", group: "recordNarrow" },
  { id: "contacts", label: "連絡先", group: "recordNarrow" },
];

describe("sectionLayout", () => {
  it("falls back to catalog order when no preference is stored", () => {
    expect(groupOrdered(CATALOG, [], "venueInfo").map((s) => s.id)).toEqual(["venue", "access"]);
  });

  it("sortByOrder honours the preferred order, then catalog order for the rest", () => {
    const order = ["contacts", "links"];
    expect(sortByOrder(CATALOG.filter((s) => s.group === "recordNarrow"), CATALOG, order).map((s) => s.id)).toEqual([
      "contacts",
      "links",
    ]);
  });

  it("visibleGroup drops hidden sections but keeps the order", () => {
    const order = ["access", "venue"];
    const hidden = ["venue"];
    expect(visibleGroup(CATALOG, order, hidden, "venueInfo").map((s) => s.id)).toEqual(["access"]);
  });

  it("mergeGroupOrder replaces only the changed group and keeps others valid", () => {
    const next = mergeGroupOrder(CATALOG, [], "venueInfo", ["access", "venue"]);
    expect(next).toEqual([
      "overview",
      "access",
      "venue",
      "schedule",
      "speakers",
      "budget",
      "sponsors",
      "memo",
      "links",
      "contacts",
    ]);
    expect(groupOrdered(CATALOG, next, "venueInfo").map((s) => s.id)).toEqual(["access", "venue"]);
    // Sections never cross groups.
    expect(groupOrdered(CATALOG, next, "dayOps").map((s) => s.id)).toEqual(["schedule", "speakers"]);
  });

  it("moveTo relocates an id within a list, no-op on invalid/equal indices", () => {
    expect(moveTo(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveTo(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
    expect(moveTo(["a", "b", "c"], -1, 1)).toEqual(["a", "b", "c"]);
  });

  it("exposes the fixed groups in render order", () => {
    expect(SECTION_GROUPS).toEqual(["overview", "venueInfo", "dayOps", "opsBudget", "opsWide", "recordMemo", "recordNarrow"]);
  });
});
