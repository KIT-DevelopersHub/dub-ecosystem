import { describe, it, expect } from "vitest";
import { createEvent } from "@dub/events";
import { makeDeps, call, createApp } from "./harness";

const topic = { type: "topic", visibility: "public", name: "General" } as const;

describe("acceptance: conversation master end-to-end (test #17)", () => {
  it("create channel -> post -> cursor history -> read -> unread flows green via the app", async () => {
    const app = createApp(makeDeps());
    const c = await call(app, "POST", "/channels", { body: { ...topic, visibility: "private", memberIds: ["user_b"] } });
    const channelId = c.json.id as string;

    await call(app, "POST", "/messages", { userId: "user_b", body: { channelId, body: "hi caller" } });
    const last = await call(app, "POST", "/messages", { userId: "user_b", body: { channelId, body: "you there?" } });

    const history = await call(app, "GET", "/messages", { query: { channelId, limit: 50 } });
    expect(history.json.items.length).toBe(2);

    const before = await call(app, "GET", "/unread");
    expect(before.json.items.find((x: any) => x.channelId === channelId).unreadCount).toBe(2);

    await call(app, "POST", `/channels/${channelId}/read`, { body: { lastReadMessageId: last.json.id } });
    const after = await call(app, "GET", "/unread");
    expect(after.json.items.find((x: any) => x.channelId === channelId).unreadCount).toBe(0);
  });
});

describe("acceptance: chat.message.created canonical envelope", () => {
  it("createEvent wraps the frozen payload in a canonical envelope (ULID id = idempotency key)", () => {
    const env1 = createEvent(
      "chat.message.created",
      { channelId: "chan_1", messageId: "msg_1", authorId: "user_a" },
      { requestId: "req_1", actorId: "user_a" },
    );
    expect(env1.name).toBe("chat.message.created");
    expect(env1.version).toBe(1);
    expect(env1.requestId).toBe("req_1");
    expect(env1.actorId).toBe("user_a");
    expect(typeof env1.occurredAt).toBe("string");
    expect(env1.id).toHaveLength(26); // ULID
    expect(env1.payload).toEqual({ channelId: "chan_1", messageId: "msg_1", authorId: "user_a" });

    // distinct idempotency ids per event
    const env2 = createEvent(
      "chat.message.created",
      { channelId: "chan_1", messageId: "msg_2", authorId: "user_a" },
      { requestId: "req_1", actorId: "user_a" },
    );
    expect(env2.id).not.toBe(env1.id);
  });
});
