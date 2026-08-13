import { describe, expect, it } from "vitest";
import { groupInboxItems } from "../src/lib/group-inbox";
import type { InboxItem } from "../src/contracts/notification-api";

function item(over: Partial<InboxItem> & Pick<InboxItem, "id" | "type">): InboxItem {
  return {
    title: over.type,
    body: "",
    readAt: null,
    createdAt: "2026-08-12T00:00:00.000Z",
    resourceType: null,
    resourceId: null,
    ...over,
  } as InboxItem;
}

describe("groupInboxItems", () => {
  it("groups by app and orders sections release → task → event → system", () => {
    const groups = groupInboxItems([
      item({ id: "n1", type: "task.assigned" }),
      item({ id: "n2", type: "release" }),
      item({ id: "n3", type: "event.invited" }),
      item({ id: "n4", type: "system.announcement" }),
    ]);
    expect(groups.map((g) => g.group)).toEqual(["release", "task", "event", "system"]);
  });

  it("drops empty sections and preserves per-section incoming order", () => {
    const groups = groupInboxItems([
      item({ id: "n1", type: "task.due_soon" }),
      item({ id: "n2", type: "task.assigned" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.group).toBe("task");
    expect(groups[0]!.items.map((i) => i.id)).toEqual(["n1", "n2"]);
  });

  it("counts unread per section for header emphasis", () => {
    const groups = groupInboxItems([
      item({ id: "n1", type: "task.assigned", readAt: null }),
      item({ id: "n2", type: "task.completed", readAt: "2026-08-12T01:00:00.000Z" }),
    ]);
    expect(groups[0]!.unread).toBe(1);
  });

  it("routes unknown types into the system section (never crashes)", () => {
    const groups = groupInboxItems([item({ id: "n1", type: "weird.unknown" })]);
    expect(groups[0]!.group).toBe("system");
  });
});
