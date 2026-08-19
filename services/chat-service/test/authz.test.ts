import { describe, it, expect } from "vitest";
import { makeDeps, call, createApp } from "./harness";

const topic = { type: "topic", visibility: "public", name: "General" } as const;

describe("authentication + channel-scoped authorization", () => {
  it("unauthenticated request (no x-dub-user-id) -> 401", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "GET", "/chat/channels", { userId: null });
    expect(res.status).toBe(401);
  });

  it("non-member posting to a public channel -> 201 and auto-joins (Slack-style)", async () => {
    const app = createApp(makeDeps());
    const c = await call(app, "POST", "/chat/channels", { body: topic });
    const res = await call(app, "POST", "/chat/messages", { userId: "user_stranger", body: { channelId: c.json.id, body: "hi" } });
    expect(res.status).toBe(201);
    // the writer is now a member (auto-join), so the channel shows in their list
    const mine = await call(app, "GET", "/chat/channels", { userId: "user_stranger" });
    expect(mine.json.items.some((ch: { id: string }) => ch.id === c.json.id)).toBe(true);
  });

  it("non-member cannot POST to a PRIVATE channel -> 404 (hidden)", async () => {
    const app = createApp(makeDeps());
    const c = await call(app, "POST", "/chat/channels", { body: { ...topic, visibility: "private" } });
    const res = await call(app, "POST", "/chat/messages", { userId: "user_stranger", body: { channelId: c.json.id, body: "hi" } });
    expect(res.status).toBe(404);
  });

  it("non-member CAN list a public channel's messages -> 200 (public = read without join)", async () => {
    const app = createApp(makeDeps());
    const c = await call(app, "POST", "/chat/channels", { body: topic });
    const res = await call(app, "GET", "/chat/messages", { userId: "user_stranger", query: { channelId: c.json.id } });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json.items)).toBe(true);
  });

  it("non-member CAN mark a public channel read + get a ws-ticket -> 200", async () => {
    const app = createApp(makeDeps());
    const c = await call(app, "POST", "/chat/channels", { body: topic });
    const posted = await call(app, "POST", "/chat/messages", { body: { channelId: c.json.id, body: "hi" } });
    const read = await call(app, "POST", `/chat/channels/${c.json.id}/read`, {
      userId: "user_stranger",
      body: { lastReadMessageId: posted.json.id },
    });
    expect(read.status).toBe(200);
    const ticket = await call(app, "GET", `/chat/channels/${c.json.id}/ws-ticket`, { userId: "user_stranger" });
    expect(ticket.status).toBe(200);
  });

  it("non-member still cannot list a PRIVATE channel's messages -> 404 (hidden)", async () => {
    const app = createApp(makeDeps());
    const c = await call(app, "POST", "/chat/channels", { body: { ...topic, visibility: "private" } });
    const res = await call(app, "GET", "/chat/messages", { userId: "user_stranger", query: { channelId: c.json.id } });
    expect(res.status).toBe(404);
  });

  it("non-member private channel history -> 404 (existence hidden)", async () => {
    const app = createApp(makeDeps());
    const c = await call(app, "POST", "/chat/channels", { body: { ...topic, visibility: "private" } });
    const res = await call(app, "GET", "/chat/messages", { userId: "user_stranger", query: { channelId: c.json.id } });
    expect(res.status).toBe(404);
  });
});
