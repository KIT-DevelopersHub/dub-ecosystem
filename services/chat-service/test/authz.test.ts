import { describe, it, expect } from "vitest";
import { makeDeps, call, createApp } from "./harness";

const topic = { type: "topic", visibility: "public", name: "General" } as const;

describe("authentication + channel-scoped authorization", () => {
  it("unauthenticated request (no x-dub-user-id) -> 401", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "GET", "/chat/channels", { userId: null });
    expect(res.status).toBe(401);
  });

  it("non-member cannot POST to a public channel -> 403", async () => {
    const app = createApp(makeDeps());
    const c = await call(app, "POST", "/chat/channels", { body: topic });
    const res = await call(app, "POST", "/chat/messages", { userId: "user_stranger", body: { channelId: c.json.id, body: "hi" } });
    expect(res.status).toBe(403);
  });

  it("non-member cannot list a public channel's messages -> 403", async () => {
    const app = createApp(makeDeps());
    const c = await call(app, "POST", "/chat/channels", { body: topic });
    const res = await call(app, "GET", "/chat/messages", { userId: "user_stranger", query: { channelId: c.json.id } });
    expect(res.status).toBe(403);
  });

  it("non-member private channel history -> 404 (existence hidden)", async () => {
    const app = createApp(makeDeps());
    const c = await call(app, "POST", "/chat/channels", { body: { ...topic, visibility: "private" } });
    const res = await call(app, "GET", "/chat/messages", { userId: "user_stranger", query: { channelId: c.json.id } });
    expect(res.status).toBe(404);
  });
});
