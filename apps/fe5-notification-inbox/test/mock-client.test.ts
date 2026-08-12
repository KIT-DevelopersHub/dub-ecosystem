import { describe, expect, it } from "vitest";
import { createNotificationApi } from "../src/api/client";
import { createMockApiClient, DEFAULT_PREFERENCES, MockApiError } from "../src/api/mock-client";
import { isApiError } from "../src/contracts/fe2";

describe("mock notification api (contract adherence)", () => {
  it("lists inbox with a Paginated<InboxItem> shape and honours unreadOnly", async () => {
    const api = createNotificationApi(createMockApiClient());
    const all = await api.listInbox({ limit: 50 });
    expect(Array.isArray(all.items)).toBe(true);
    expect("nextCursor" in all).toBe(true);
    const unread = await api.listInbox({ unreadOnly: true });
    expect(unread.items.every((i) => i.readAt === null)).toBe(true);
  });

  it("paginates with an opaque cursor", async () => {
    const api = createNotificationApi(createMockApiClient({ pageSize: 2 }));
    const p1 = await api.listInbox({ limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await api.listInbox({ cursor: p1.nextCursor!, limit: 2 });
    expect(p2.items[0]!.id).not.toBe(p1.items[0]!.id);
  });

  it("unread-count reflects mark-read", async () => {
    const client = createMockApiClient();
    const api = createNotificationApi(client);
    const before = (await api.getUnreadCount()).count;
    const firstUnread = client.__store.items.find((i) => i.readAt === null)!;
    await api.markRead(firstUnread.id);
    expect((await api.getUnreadCount()).count).toBe(before - 1);
  });

  it("markRead on an unknown id throws a 404 ApiError with the notif code", async () => {
    const api = createNotificationApi(createMockApiClient());
    await expect(api.markRead("notif_does_not_exist")).rejects.toSatisfy((e: unknown) => {
      return isApiError(e) && e.status === 404 && e.code === "NOTIF_INBOX_ITEM_NOT_FOUND";
    });
  });

  it("markAllRead with a type prefix only marks that group", async () => {
    const client = createMockApiClient();
    const api = createNotificationApi(client);
    await api.markAllRead({ type: "task." });
    const remaining = client.__store.items.filter((i) => i.readAt === null);
    expect(remaining.every((i) => !i.type.startsWith("task."))).toBe(true);
  });

  it("preferences round-trip: defaults returned, override persisted", async () => {
    const api = createNotificationApi(createMockApiClient());
    const prefs = await api.getPreferences();
    expect(prefs.defaults).toEqual(DEFAULT_PREFERENCES);
    await api.updatePreferences({ entries: [{ type: "task.*", channels: ["in_app"] }] });
    const after = await api.getPreferences();
    expect(after.overrides).toContainEqual({ type: "task.*", channels: ["in_app"] });
  });

  it("default preferences keep chat off (chat.* transcription off)", () => {
    for (const entry of DEFAULT_PREFERENCES) {
      expect(entry.channels).not.toContain("chat");
    }
  });

  it("publishRelease adds a new unread release note to the top of the inbox", async () => {
    const client = createMockApiClient();
    const api = createNotificationApi(client);
    const before = (await api.getUnreadCount()).count;
    const res = await api.publishRelease({ title: "🎉 新機能テスト", body: "できること", app: "テスト" });
    expect(res.deduplicated).toBe(false);
    expect((await api.getUnreadCount()).count).toBe(before + 1);
    const top = client.__store.items[0]!;
    expect(top.type).toBe("release");
    expect(top.title).toBe("🎉 新機能テスト");
    expect(top.readAt).toBeNull();
  });

  it("seeds two release notes shown as type=release", async () => {
    const client = createMockApiClient();
    expect(client.__store.items.filter((i) => i.type === "release").length).toBeGreaterThanOrEqual(2);
  });

  it("failNext forces the next matching call to reject", async () => {
    const api = createNotificationApi(
      createMockApiClient({
        failNext: { pathIncludes: "/read", error: new MockApiError("INTERNAL", 500, "boom", true) },
      }),
    );
    await expect(api.markRead("notif_0001")).rejects.toThrow("boom");
  });
});
