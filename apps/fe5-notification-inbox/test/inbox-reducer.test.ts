import { describe, expect, it } from "vitest";
import type { InboxItem } from "../src/contracts/notification-api";
import {
  EMPTY_INBOX,
  appendPage,
  hasMore,
  markAllReadLocally,
  markReadLocally,
  markUnreadLocally,
  removeItem,
  replaceFirstPage,
  unreadCount,
} from "../src/lib/inbox-reducer";

function item(id: string, type: string, read = false): InboxItem {
  return {
    id,
    type,
    title: id,
    body: "",
    readAt: read ? "2026-08-09T00:00:00Z" : null,
    createdAt: "2026-08-09T00:00:00Z",
    resourceType: null,
    resourceId: null,
  };
}

describe("inbox reducer", () => {
  it("appendPage dedupes by id and tracks nextCursor / hasMore", () => {
    let s = replaceFirstPage(EMPTY_INBOX, {
      items: [item("a", "task.x"), item("b", "task.y")],
      nextCursor: "2",
    });
    expect(hasMore(s)).toBe(true);
    s = appendPage(s, { items: [item("b", "task.y"), item("c", "task.z")], nextCursor: null });
    expect(s.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(hasMore(s)).toBe(false);
  });

  it("markReadLocally sets readAt only for the target unread item and returns a rollback snapshot", () => {
    const s = replaceFirstPage(EMPTY_INBOX, {
      items: [item("a", "task.x"), item("b", "task.y")],
      nextCursor: null,
    });
    const [next, prev] = markReadLocally(s, "a", "2026-08-09T01:00:00Z");
    expect(next.items.find((i) => i.id === "a")!.readAt).toBe("2026-08-09T01:00:00Z");
    expect(next.items.find((i) => i.id === "b")!.readAt).toBeNull();
    expect(prev).toBe(s); // snapshot for rollback
  });

  it("markAllReadLocally respects a type prefix", () => {
    const s = replaceFirstPage(EMPTY_INBOX, {
      items: [item("a", "task.x"), item("b", "event.y")],
      nextCursor: null,
    });
    const [next] = markAllReadLocally(s, "2026-08-09T01:00:00Z", "task.");
    expect(next.items.find((i) => i.id === "a")!.readAt).not.toBeNull();
    expect(next.items.find((i) => i.id === "b")!.readAt).toBeNull();
  });

  it("markUnreadLocally clears readAt for a read item and returns a rollback snapshot", () => {
    const s = replaceFirstPage(EMPTY_INBOX, {
      items: [item("a", "task.x", true), item("b", "task.y")],
      nextCursor: null,
    });
    expect(unreadCount(s)).toBe(1);
    const [next, prev] = markUnreadLocally(s, "a");
    expect(next.items.find((i) => i.id === "a")!.readAt).toBeNull();
    expect(unreadCount(next)).toBe(2);
    expect(prev).toBe(s); // snapshot for rollback
  });

  it("removeItem drops a row and unreadCount counts remaining unread", () => {
    const s = replaceFirstPage(EMPTY_INBOX, {
      items: [item("a", "task.x"), item("b", "task.y", true)],
      nextCursor: null,
    });
    expect(unreadCount(s)).toBe(1);
    const r = removeItem(s, "a");
    expect(r.items.map((i) => i.id)).toEqual(["b"]);
    expect(unreadCount(r)).toBe(0);
  });
});
