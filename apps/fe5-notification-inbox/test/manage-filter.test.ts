import { describe, it, expect } from "vitest";
import type { AdminNotificationItem } from "../src/contracts/notification-api";
import {
  categoryOf,
  availableCategories,
  filterByCategory,
  publishableIds,
  allPublishableSelected,
} from "../src/lib/manage-filter";

const mk = (id: string, type: string, published = false): AdminNotificationItem => ({
  id,
  type,
  title: `t-${id}`,
  body: "b",
  audience: "admin",
  createdAt: "2026-08-02T00:00:00Z",
  publishedBroadcastId: published ? "bc" : null,
});

const items: AdminNotificationItem[] = [
  mk("a", "release"),
  mk("b", "release.new_feature"),
  mk("c", "deploy.deployment.status_changed"),
  mk("d", "feedback", true), // already published
];

describe("manage-filter", () => {
  it("classifies release into 'release' and admin ops into 'system'", () => {
    expect(categoryOf(items[0]!)).toBe("release");
    expect(categoryOf(items[2]!)).toBe("system");
    expect(categoryOf(items[3]!)).toBe("system");
  });

  it("lists only the categories present, with counts, in group order", () => {
    const cats = availableCategories(items);
    expect(cats.map((c) => c.value)).toEqual(["release", "system"]);
    expect(cats.find((c) => c.value === "release")!.count).toBe(2);
    expect(cats.find((c) => c.value === "system")!.count).toBe(2);
  });

  it("filters by category (null == all)", () => {
    expect(filterByCategory(items, null)).toHaveLength(4);
    expect(filterByCategory(items, "release").map((i) => i.id)).toEqual(["a", "b"]);
    expect(filterByCategory(items, "system").map((i) => i.id)).toEqual(["c", "d"]);
  });

  it("publishableIds excludes already-published rows", () => {
    expect(publishableIds(items)).toEqual(["a", "b", "c"]); // d is published
    expect(publishableIds(filterByCategory(items, "system"))).toEqual(["c"]);
  });

  it("allPublishableSelected reflects the filtered publishable set", () => {
    expect(allPublishableSelected(items, new Set())).toBe(false);
    expect(allPublishableSelected(items, new Set(["a", "b", "c"]))).toBe(true);
    // d is published (not publishable), so selecting a/b/c is 'all'.
    const systemOnly = filterByCategory(items, "system");
    expect(allPublishableSelected(systemOnly, new Set(["c"]))).toBe(true);
    expect(allPublishableSelected(systemOnly, new Set())).toBe(false);
  });
});
