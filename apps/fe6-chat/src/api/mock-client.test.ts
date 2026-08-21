import { describe, it, expect, beforeEach } from "vitest";
import { MockChatClient } from "./mock-client";
import { ChatApiError } from "./client";
import { demoSeed, ME, OTHER } from "../dev/seed";

const GENERAL = "chn_general00000000000000000";
const ARCHIVED = "chn_archived0000000000000000";

describe("MockChatClient", () => {
  let api: MockChatClient;
  beforeEach(() => {
    api = new MockChatClient(demoSeed());
  });

  it("lists channels and filters by eventId", async () => {
    expect((await api.listChannels()).length).toBe(8);
    const evChannels = await api.listChannels("evt_conf000000000000000000");
    expect(evChannels).toHaveLength(1);
    expect(evChannels[0]!.type).toBe("event");
  });

  it("rejects posting an empty body with VALIDATION_FAILED", async () => {
    await expect(api.postMessage({ channelId: GENERAL, body: "   ", clientTempId: "t" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it("rejects posting to an archived channel with CHAT_ARCHIVED_CHANNEL", async () => {
    await expect(api.postMessage({ channelId: ARCHIVED, body: "hi", clientTempId: "t" })).rejects.toMatchObject({
      code: "CHAT_ARCHIVED_CHANNEL",
    });
  });

  it("posts and returns the clientTempId for reconciliation", async () => {
    const res = await api.postMessage({ channelId: GENERAL, body: "new one", clientTempId: "tmp_42" });
    expect(res.clientTempId).toBe("tmp_42");
    expect(res.message.authorId).toBe(ME);
  });

  it("pages older history with an opaque cursor", async () => {
    for (let i = 0; i < 5; i++) await api.postMessage({ channelId: GENERAL, body: `m${i}`, clientTempId: `t${i}` });
    const first = await api.listMessages({ channelId: GENERAL, limit: 3 });
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
    const older = await api.listMessages({ channelId: GENERAL, cursor: first.nextCursor!, limit: 3 });
    const ids = new Set([...first.items, ...older.items].map((m) => m.id));
    expect(ids.size).toBe(first.items.length + older.items.length); // no overlap
  });

  it("gap-fills with afterMessageId in ULID-ascending order", async () => {
    const page = await api.listMessages({ channelId: GENERAL, limit: 50 });
    const lastId = page.items[page.items.length - 1]!.id;
    await api.postMessage({ channelId: GENERAL, body: "after1", clientTempId: "a1" });
    await api.postMessage({ channelId: GENERAL, body: "after2", clientTempId: "a2" });
    const gap = await api.listMessages({ channelId: GENERAL, afterMessageId: lastId });
    expect(gap.items.map((m) => m.body)).toEqual(["after1", "after2"]);
  });

  it("computes unread excluding my own messages and respecting read state", async () => {
    let unread = await api.listUnread();
    const general = unread.find((u) => u.channelId === GENERAL)!;
    expect(general.unreadCount).toBeGreaterThan(0);
    expect(general.mentioned).toBe(true); // seed has a <@me> mention
    // read to the newest -> unread clears
    const page = await api.listMessages({ channelId: GENERAL, limit: 50 });
    const lastId = page.items[page.items.length - 1]!.id;
    await api.updateReadState({ channelId: GENERAL, lastReadMessageId: lastId });
    unread = await api.listUnread();
    expect(unread.find((u) => u.channelId === GENERAL)!.unreadCount).toBe(0);
  });

  it("enforces optimistic lock on edit", async () => {
    const posted = await api.postMessage({ channelId: GENERAL, body: "edit me", clientTempId: "e1" });
    await expect(api.editMessage(posted.message.id, { body: "x", version: 99 })).rejects.toMatchObject({
      code: "CHAT_VERSION_CONFLICT",
    });
    const ok = await api.editMessage(posted.message.id, { body: "edited", version: posted.message.version });
    expect(ok.body).toBe("edited");
    expect(ok.editedAt).not.toBeNull();
  });

  it("hard-erases on delete under the default policy (no tombstone left)", async () => {
    const posted = await api.postMessage({ channelId: GENERAL, body: "del me", clientTempId: "d1" });
    const deleted = await api.deleteMessage(posted.message.id);
    expect(deleted.mode).toBe("hard");
    expect(deleted.message).toBeNull();
    // gone from the channel listing entirely
    const list = await api.listMessages({ channelId: GENERAL });
    expect(list.items.find((m) => m.id === posted.message.id)).toBeUndefined();
  });

  it("tombstones on delete when the policy is switched to tombstone", async () => {
    api.setDeletionPolicy({ member: "tombstone", moderator: "tombstone", protectReacted: false });
    const posted = await api.postMessage({ channelId: GENERAL, body: "del me", clientTempId: "d2" });
    const deleted = await api.deleteMessage(posted.message.id);
    expect(deleted.mode).toBe("tombstone");
    expect(deleted.message?.deletedAt).not.toBeNull();
    expect(deleted.message?.body).toBe("");
  });

  it("caps resolveUsers batch at 50 and falls back to id for unknowns", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `usr_${i}`);
    const res = await api.resolveUsers(ids);
    expect(res).toHaveLength(50);
    const known = await api.resolveUsers([OTHER]);
    expect(known[0]!.displayName).toBe("佐藤 花子");
  });

  it("issues a DO-direct ws ticket (doUrl absolute, gateway bypassed)", async () => {
    const ticket = await api.getWsTicket(GENERAL);
    expect(ticket.doUrl.startsWith("wss://")).toBe(true);
    expect(ticket.doUrl).not.toContain("/api/v1");
  });

  it("surfaces a primed error then resets", async () => {
    api.nextError = new ChatApiError(429, { error: { code: "RATE_LIMITED", message: "slow down", retryable: true } });
    await expect(api.postMessage({ channelId: GENERAL, body: "x", clientTempId: "r1" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    // next call succeeds
    const ok = await api.postMessage({ channelId: GENERAL, body: "y", clientTempId: "r2" });
    expect(ok.message.body).toBe("y");
  });
});
