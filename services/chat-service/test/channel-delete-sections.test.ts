import { describe, it, expect } from "vitest";
import type { identity } from "@dub/types";
import { makeDeps, call, createApp, fakeAuthz, ALL_CHAT_KEYS } from "./harness";

const topic = { type: "topic", visibility: "public", name: "General" } as const;
const WITH_DELETE = new Set<identity.PermissionKey>([...ALL_CHAT_KEYS, "chat:delete_channel"]);

describe("DELETE /chat/channels/:id (physical delete)", () => {
  it("removes the channel and every dependent row; audits chat.channel.delete", async () => {
    const deps = makeDeps({ authz: fakeAuthz(WITH_DELETE) });
    const app = createApp(deps);
    const ch = await call(app, "POST", "/chat/channels", { body: topic });
    const msg = await call(app, "POST", "/chat/messages", { body: { channelId: ch.json.id, body: "hi" } });
    await call(app, "POST", `/chat/messages/${msg.json.id}/reactions`, { body: { emoji: "👍" } });
    await call(app, "POST", `/chat/channels/${ch.json.id}/pins`, { body: { messageId: msg.json.id } });
    const sec = await call(app, "POST", "/chat/sections", { body: { name: "運営" } });
    await call(app, "PUT", `/chat/channels/${ch.json.id}/section`, { body: { sectionId: sec.json.id } });

    const res = await call(app, "DELETE", `/chat/channels/${ch.json.id}`);
    expect(res.status).toBe(204);
    expect((await call(app, "GET", `/chat/channels/${ch.json.id}`)).status).toBe(404);
    expect(await deps.repo.getMessage(msg.json.id)).toBeNull();
    expect(await deps.repo.listMembers(ch.json.id)).toEqual([]);
    expect(await deps.repo.listPinnedMessages(ch.json.id)).toEqual([]);
    expect((await deps.repo.reactionsFor([msg.json.id])).get(msg.json.id)).toBeUndefined();
    expect((await call(app, "GET", "/chat/sections")).json.assignments).toEqual({});
    expect(deps.audit.actions()).toContain("chat.channel.delete");
  });

  it("requires chat:delete_channel even for the channel admin / moderator", async () => {
    const deps = makeDeps(); // ALL_CHAT_KEYS = edit + create + moderate, no delete key
    const app = createApp(deps);
    const ch = await call(app, "POST", "/chat/channels", { body: topic });
    const res = await call(app, "DELETE", `/chat/channels/${ch.json.id}`);
    expect(res.status).toBe(403);
    expect(res.json.error.details.missing).toEqual(["chat:delete_channel"]);
    expect((await call(app, "GET", `/chat/channels/${ch.json.id}`)).status).toBe(200);
  });

  it("DMs cannot be deleted; missing / hidden channels 404", async () => {
    const app = createApp(makeDeps({ authz: fakeAuthz(WITH_DELETE) }));
    const dm = await call(app, "POST", "/chat/channels", { body: { type: "dm", visibility: "private", name: "dm", memberIds: ["user_b"] } });
    expect((await call(app, "DELETE", `/chat/channels/${dm.json.id}`)).status).toBe(400);
    expect((await call(app, "DELETE", "/chat/channels/chan_missing")).status).toBe(404);

    const priv = await call(app, "POST", "/chat/channels", { body: { ...topic, visibility: "private" } });
    expect((await call(app, "DELETE", `/chat/channels/${priv.json.id}`, { userId: "user_stranger" })).status).toBe(404);
  });
});

describe("personal sidebar sections", () => {
  it("create / list / rename / reorder / delete, appended in position order", async () => {
    const app = createApp(makeDeps());
    const a = await call(app, "POST", "/chat/sections", { body: { name: " 運営 " } });
    const b = await call(app, "POST", "/chat/sections", { body: { name: "イベント" } });
    expect(a.status).toBe(201);
    expect(a.json.name).toBe("運営");
    expect([a.json.position, b.json.position]).toEqual([0, 1]);

    const renamed = await call(app, "PATCH", `/chat/sections/${a.json.id}`, { body: { name: "運営チーム", position: 5 } });
    expect(renamed.json).toMatchObject({ name: "運営チーム", position: 5 });
    const list = await call(app, "GET", "/chat/sections");
    expect(list.json.items.map((s: { name: string }) => s.name)).toEqual(["イベント", "運営チーム"]);

    expect((await call(app, "DELETE", `/chat/sections/${b.json.id}`)).status).toBe(204);
    expect((await call(app, "GET", "/chat/sections")).json.items).toHaveLength(1);
  });

  it("validates the name", async () => {
    const app = createApp(makeDeps());
    expect((await call(app, "POST", "/chat/sections", { body: { name: "  " } })).status).toBe(400);
    expect((await call(app, "POST", "/chat/sections", { body: { name: "x".repeat(41) } })).status).toBe(400);
    for (let i = 0; i < 50; i++) await call(app, "POST", "/chat/sections", { body: { name: `s${i}` } });
    expect((await call(app, "POST", "/chat/sections", { body: { name: "one too many" } })).status).toBe(400);
  });

  it("assigns / moves / unassigns a channel; deleting the section returns it to default", async () => {
    const app = createApp(makeDeps());
    const ch = await call(app, "POST", "/chat/channels", { body: topic });
    const a = await call(app, "POST", "/chat/sections", { body: { name: "A" } });
    const b = await call(app, "POST", "/chat/sections", { body: { name: "B" } });

    expect((await call(app, "PUT", `/chat/channels/${ch.json.id}/section`, { body: { sectionId: a.json.id } })).status).toBe(204);
    await call(app, "PUT", `/chat/channels/${ch.json.id}/section`, { body: { sectionId: b.json.id } });
    expect((await call(app, "GET", "/chat/sections")).json.assignments).toEqual({ [ch.json.id]: b.json.id });

    await call(app, "PUT", `/chat/channels/${ch.json.id}/section`, { body: { sectionId: null } });
    expect((await call(app, "GET", "/chat/sections")).json.assignments).toEqual({});

    await call(app, "PUT", `/chat/channels/${ch.json.id}/section`, { body: { sectionId: a.json.id } });
    await call(app, "DELETE", `/chat/sections/${a.json.id}`);
    expect((await call(app, "GET", "/chat/sections")).json.assignments).toEqual({});
    expect((await call(app, "GET", `/chat/channels/${ch.json.id}`)).status).toBe(200);
  });

  it("sections are per user: others cannot see, edit, delete or assign into them", async () => {
    const app = createApp(makeDeps());
    const ch = await call(app, "POST", "/chat/channels", { body: topic });
    const mine = await call(app, "POST", "/chat/sections", { body: { name: "mine" } });
    const other = { userId: "user_b" };

    expect((await call(app, "GET", "/chat/sections", other)).json).toEqual({ items: [], assignments: {} });
    expect((await call(app, "PATCH", `/chat/sections/${mine.json.id}`, { ...other, body: { name: "x" } })).status).toBe(404);
    expect((await call(app, "DELETE", `/chat/sections/${mine.json.id}`, other)).status).toBe(404);
    expect((await call(app, "PUT", `/chat/channels/${ch.json.id}/section`, { ...other, body: { sectionId: mine.json.id } })).status).toBe(404);
  });

  it("cannot assign a private channel the caller cannot read", async () => {
    const app = createApp(makeDeps());
    const priv = await call(app, "POST", "/chat/channels", { body: { ...topic, visibility: "private" } });
    const sec = await call(app, "POST", "/chat/sections", { userId: "user_b", body: { name: "s" } });
    const res = await call(app, "PUT", `/chat/channels/${priv.json.id}/section`, { userId: "user_b", body: { sectionId: sec.json.id } });
    expect(res.status).toBe(404);
  });
});
