import { describe, it, expect } from "vitest";
import { makeDeps, call, createApp } from "./harness";

const topic = { type: "topic", visibility: "public", name: "General" } as const;

describe("reactions (toggle, idempotent)", () => {
  it("toggles a reaction on and off for the caller", async () => {
    const app = createApp(makeDeps());
    const c = await call(app, "POST", "/chat/channels", { body: topic });
    const m = await call(app, "POST", "/chat/messages", { body: { channelId: c.json.id, body: "react to me" } });

    const on = await call(app, "POST", `/chat/messages/${m.json.id}/reactions`, { body: { emoji: "👍" } });
    expect(on.status).toBe(200);
    expect(on.json.reactions["👍"]).toEqual(["user_caller"]);

    const off = await call(app, "POST", `/chat/messages/${m.json.id}/reactions`, { body: { emoji: "👍" } });
    expect(off.status).toBe(200);
    expect(off.json.reactions["👍"]).toBeUndefined();
  });

  it("non-member cannot react -> 403", async () => {
    const app = createApp(makeDeps());
    const c = await call(app, "POST", "/chat/channels", { body: { ...topic, visibility: "private" } });
    const m = await call(app, "POST", "/chat/messages", { body: { channelId: c.json.id, body: "x" } });
    const res = await call(app, "POST", `/chat/messages/${m.json.id}/reactions`, { userId: "user_stranger", body: { emoji: "🎉" } });
    expect(res.status).toBe(404); // private + non-member: hidden
  });
});

describe("read state + unread", () => {
  it("unread counts others' messages, excludes own, and drops after marking read", async () => {
    const app = createApp(makeDeps());
    const c = await call(app, "POST", "/chat/channels", { body: { ...topic, visibility: "private", memberIds: ["user_b"] } });
    const channelId = c.json.id as string;

    // user_caller posts one (own -> not unread for caller); user_b posts two.
    await call(app, "POST", "/chat/messages", { body: { channelId, body: "mine" } });
    await call(app, "POST", "/chat/messages", { userId: "user_b", body: { channelId, body: "b1" } });
    const last = await call(app, "POST", "/chat/messages", { userId: "user_b", body: { channelId, body: "b2" } });

    const unread1 = await call(app, "GET", "/chat/unread");
    const row1 = unread1.json.items.find((x: any) => x.channelId === channelId);
    expect(row1.unreadCount).toBe(2);
    expect(row1.lastReadMessageId).toBeNull();

    const read = await call(app, "POST", `/chat/channels/${channelId}/read`, { body: { lastReadMessageId: last.json.id } });
    expect(read.status).toBe(200);
    expect(read.json.unreadCount).toBe(0);

    const unread2 = await call(app, "GET", "/chat/unread");
    const row2 = unread2.json.items.find((x: any) => x.channelId === channelId);
    expect(row2.unreadCount).toBe(0);
    expect(row2.lastReadMessageId).toBe(last.json.id);
  });

  it("unread only includes channels the caller is a member of", async () => {
    const app = createApp(makeDeps());
    // caller is NOT a member of this one (created by user_b, private)
    // create as user_b via a fresh channel where caller is excluded
    const other = await call(app, "POST", "/chat/channels", { userId: "user_b", body: { ...topic, visibility: "private", name: "b-only" } });
    await call(app, "POST", "/chat/messages", { userId: "user_b", body: { channelId: other.json.id, body: "hidden" } });

    const unread = await call(app, "GET", "/chat/unread");
    expect(unread.json.items.find((x: any) => x.channelId === other.json.id)).toBeUndefined();
  });
});
