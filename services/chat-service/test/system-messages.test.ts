import { describe, it, expect } from "vitest";
import { makeDeps, call, createApp } from "./harness";

const topic = { type: "topic", visibility: "public", name: "General" } as const;

describe("POST /internal/system-messages", () => {
  it("without the x-dub-internal marker -> 404 (hidden)", async () => {
    const app = createApp(makeDeps());
    const c = await call(app, "POST", "/chat/channels", { body: topic });
    const res = await call(app, "POST", "/internal/system-messages", { body: { channelId: c.json.id, body: "sys" } });
    expect(res.status).toBe(404);
  });

  it("posts a system message to a channel (kind=system, authorId=null) without emitting chat.message.created", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const c = await call(app, "POST", "/chat/channels", { body: topic });
    const res = await call(app, "POST", "/internal/system-messages", { internal: true, body: { channelId: c.json.id, body: "maintenance at 5pm" } });
    expect(res.status).toBe(201);
    expect(res.json.kind).toBe("system");
    expect(res.json.authorId).toBeNull();
    // system posts must NOT re-enter the domain event stream
    expect(deps.publisher.namesFor("chat.message.created")).toHaveLength(0);
    expect(deps.audit.actions()).toContain("chat.system.post");
  });

  it("targetUserId resolves (and dedups) a DM channel via dm_key", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const first = await call(app, "POST", "/internal/system-messages", { internal: true, body: { targetUserId: "user_z", body: "welcome" } });
    expect(first.status).toBe(201);
    const second = await call(app, "POST", "/internal/system-messages", { internal: true, body: { targetUserId: "user_z", body: "again" } });
    expect(second.status).toBe(201);
    // same DM channel reused (no duplicate creation)
    expect(second.json.channelId).toBe(first.json.channelId);
  });

  it("requires exactly one of channelId / targetUserId", async () => {
    const app = createApp(makeDeps());
    const both = await call(app, "POST", "/internal/system-messages", { internal: true, body: { channelId: "chan_x", targetUserId: "user_z", body: "b" } });
    expect(both.status).toBe(400);
    const neither = await call(app, "POST", "/internal/system-messages", { internal: true, body: { body: "b" } });
    expect(neither.status).toBe(400);
  });

  it("unknown channelId -> 404", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "POST", "/internal/system-messages", { internal: true, body: { channelId: "chan_missing", body: "b" } });
    expect(res.status).toBe(404);
  });
});
