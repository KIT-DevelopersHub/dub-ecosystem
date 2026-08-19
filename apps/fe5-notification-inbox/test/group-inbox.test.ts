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

describe("groupInboxItems (by category)", () => {
  it("groups by category and orders sections app_update → mail → participation → other", () => {
    const groups = groupInboxItems([
      item({ id: "n1", type: "task.assigned" }), // other
      item({ id: "n2", type: "release" }), // app_update
      item({ id: "n3", type: "mail.message.received" }), // mail
      item({ id: "n4", type: "member.participation.submitted" }), // participation
    ]);
    expect(groups.map((g) => g.group)).toEqual(["app_update", "mail", "participation", "other"]);
  });

  it("treats deploy.* and release/release.* as the same app_update section", () => {
    const groups = groupInboxItems([
      item({ id: "n1", type: "deploy.deployment.status_changed" }),
      item({ id: "n2", type: "release.notes" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.group).toBe("app_update");
    expect(groups[0]!.items.map((i) => i.id)).toEqual(["n1", "n2"]);
  });

  it("drops empty sections and preserves per-section incoming order", () => {
    const groups = groupInboxItems([
      item({ id: "n1", type: "mail.message.sent" }),
      item({ id: "n2", type: "mail.message.received" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.group).toBe("mail");
    expect(groups[0]!.items.map((i) => i.id)).toEqual(["n1", "n2"]);
  });

  it("counts unread per section for header emphasis", () => {
    const groups = groupInboxItems([
      item({ id: "n1", type: "mail.message.received", readAt: null }),
      item({ id: "n2", type: "mail.message.sent", readAt: "2026-08-12T01:00:00.000Z" }),
    ]);
    expect(groups[0]!.unread).toBe(1);
  });

  it("routes tasks/events/unknown types into the その他 (other) section (never crashes)", () => {
    const groups = groupInboxItems([
      item({ id: "n1", type: "task.assigned" }),
      item({ id: "n2", type: "event.invited" }),
      item({ id: "n3", type: "weird.unknown" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.group).toBe("other");
  });
});
