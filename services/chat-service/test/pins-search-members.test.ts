// HTTP-level coverage for the Slack-parity surface FE6 depends on: channel members
// roster, workspace/channel search, and pinned messages. Drives the real Hono app
// (under the /chat mount) end-to-end against InMemoryChatRepo via the harness.
import { describe, it, expect } from "vitest";
import { makeDeps, call, createApp } from "./harness";

const topic = { type: "topic", visibility: "public", name: "General" } as const;

describe("GET /chat/channels/:id/members", () => {
  it("returns the roster (creator = admin) for a channel the caller can read", async () => {
    const app = createApp(makeDeps());
    const c = await call(app, "POST", "/chat/channels", { body: { ...topic, visibility: "private", memberIds: ["user_b"] } });
    const res = await call(app, "GET", `/chat/channels/${c.json.id}/members`);
    expect(res.status).toBe(200);
    const byUser = new Map<string, any>(res.json.map((m: any) => [m.userId, m]));
    expect(byUser.get("user_caller").role).toBe("admin");
    expect(byUser.get("user_b").role).toBe("member");
  });

  it("private channel: non-member roster read -> 404 (hidden)", async () => {
    const app = createApp(makeDeps());
    const c = await call(app, "POST", "/chat/channels", { body: { ...topic, visibility: "private" } });
    const res = await call(app, "GET", `/chat/channels/${c.json.id}/members`, { userId: "user_stranger" });
    expect(res.status).toBe(404);
  });

  it("unauthenticated -> 401", async () => {
    const app = createApp(makeDeps());
    const c = await call(app, "POST", "/chat/channels", { body: topic });
    const res = await call(app, "GET", `/chat/channels/${c.json.id}/members`, { userId: null });
    expect(res.status).toBe(401);
  });
});

describe("GET /chat/search", () => {
  it("substring-matches over readable channels, newest-first; excludes private non-member + tombstones", async () => {
    const app = createApp(makeDeps());
    const pub = await call(app, "POST", "/chat/channels", { body: { ...topic, name: "pub" } });
    await call(app, "POST", "/chat/messages", { body: { channelId: pub.json.id, body: "Deploy the ROCKET now" } });
    const doomed = await call(app, "POST", "/chat/messages", { body: { channelId: pub.json.id, body: "rocket typo" } });
    await call(app, "DELETE", `/chat/messages/${doomed.json.id}`); // tombstone -> excluded

    // a private channel the caller cannot see
    const priv = await call(app, "POST", "/chat/channels", { userId: "user_b", body: { ...topic, visibility: "private", name: "secret" } });
    await call(app, "POST", "/chat/messages", { userId: "user_b", body: { channelId: priv.json.id, body: "rocket secrets" } });

    const res = await call(app, "GET", "/chat/search", { query: { q: "rocket" } });
    expect(res.status).toBe(200);
    expect(res.json).toHaveLength(1);
    expect(res.json[0].channelName).toBe("pub");
    expect(res.json[0].channelType).toBe("topic");
    expect(res.json[0].message.body).toContain("ROCKET");
  });

  it("channelId scope narrows results; empty query -> []", async () => {
    const app = createApp(makeDeps());
    const a = await call(app, "POST", "/chat/channels", { body: { ...topic, name: "a" } });
    const b = await call(app, "POST", "/chat/channels", { body: { ...topic, name: "b" } });
    await call(app, "POST", "/chat/messages", { body: { channelId: a.json.id, body: "hello world" } });
    await call(app, "POST", "/chat/messages", { body: { channelId: b.json.id, body: "hello there" } });

    const scoped = await call(app, "GET", "/chat/search", { query: { q: "hello", channelId: a.json.id } });
    expect(scoped.json).toHaveLength(1);
    expect(scoped.json[0].channelId).toBe(a.json.id);

    const empty = await call(app, "GET", "/chat/search", { query: { q: "   " } });
    expect(empty.status).toBe(200);
    expect(empty.json).toEqual([]);
  });
});

describe("pins: GET + POST /chat/channels/:id/pins", () => {
  it("toggles a pin on/off and returns the updated list (newest-first)", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const c = await call(app, "POST", "/chat/channels", { body: topic });
    const m1 = await call(app, "POST", "/chat/messages", { body: { channelId: c.json.id, body: "pin me 1" } });
    const m2 = await call(app, "POST", "/chat/messages", { body: { channelId: c.json.id, body: "pin me 2" } });

    expect((await call(app, "GET", `/chat/channels/${c.json.id}/pins`)).json).toEqual([]);

    const p1 = await call(app, "POST", `/chat/channels/${c.json.id}/pins`, { body: { messageId: m1.json.id } });
    expect(p1.status).toBe(200);
    expect(p1.json.map((m: any) => m.id)).toEqual([m1.json.id]);

    const p2 = await call(app, "POST", `/chat/channels/${c.json.id}/pins`, { body: { messageId: m2.json.id } });
    expect(p2.json.map((m: any) => m.id)).toEqual([m2.json.id, m1.json.id]); // id desc

    // toggle m1 off
    const p3 = await call(app, "POST", `/chat/channels/${c.json.id}/pins`, { body: { messageId: m1.json.id } });
    expect(p3.json.map((m: any) => m.id)).toEqual([m2.json.id]);

    expect(deps.audit.actions()).toContain("chat.message.pin");
    expect(deps.audit.actions()).toContain("chat.message.unpin");
  });

  it("pinning a message from another channel -> 400", async () => {
    const app = createApp(makeDeps());
    const c1 = await call(app, "POST", "/chat/channels", { body: { ...topic, name: "c1" } });
    const c2 = await call(app, "POST", "/chat/channels", { body: { ...topic, name: "c2" } });
    const m = await call(app, "POST", "/chat/messages", { body: { channelId: c2.json.id, body: "elsewhere" } });
    const res = await call(app, "POST", `/chat/channels/${c1.json.id}/pins`, { body: { messageId: m.json.id } });
    expect(res.status).toBe(400);
  });

  it("non-member cannot pin (private -> 404 hidden)", async () => {
    const app = createApp(makeDeps());
    const c = await call(app, "POST", "/chat/channels", { body: { ...topic, visibility: "private" } });
    const m = await call(app, "POST", "/chat/messages", { body: { channelId: c.json.id, body: "x" } });
    const res = await call(app, "POST", `/chat/channels/${c.json.id}/pins`, { userId: "user_stranger", body: { messageId: m.json.id } });
    expect(res.status).toBe(404);
  });
});
