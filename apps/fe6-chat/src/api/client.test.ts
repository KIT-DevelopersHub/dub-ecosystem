// Regression: HttpChatClient must unwrap the `common.Paginated` envelope
// ({ items, nextCursor }) that chat-service / identity return for channels,
// unread and user-resolution. Before the fix the client returned the raw
// envelope object; downstream `for..of`/spread then threw "e is not iterable"
// and the whole chat app crashed at the error boundary (chat error-fix).
import { describe, it, expect } from "vitest";
import { HttpChatClient } from "./client";

/** Build a fetch stub that returns `body` as JSON 200 for every request. */
function fetchReturning(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("HttpChatClient envelope unwrapping", () => {
  it("listChannels unwraps a Paginated envelope to an array", async () => {
    const channel = { id: "ch_1", type: "topic", name: "general" };
    const client = new HttpChatClient({ fetchImpl: fetchReturning({ items: [channel], nextCursor: null }) });
    const out = await client.listChannels();
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("ch_1");
  });

  it("listChannels tolerates a bare array (mock / legacy shape)", async () => {
    const client = new HttpChatClient({ fetchImpl: fetchReturning([{ id: "ch_2" }]) });
    const out = await client.listChannels();
    expect(Array.isArray(out)).toBe(true);
    expect(out[0]!.id).toBe("ch_2");
  });

  it("listChannels never yields a non-iterable (null / object without items)", async () => {
    const client = new HttpChatClient({ fetchImpl: fetchReturning(null) });
    const out = await client.listChannels();
    expect(out).toEqual([]);
    // must be safe to spread / iterate
    expect([...out]).toEqual([]);
  });

  it("listUnread unwraps { items } to an array", async () => {
    const summary = { channelId: "ch_1", unreadCount: 3, lastReadMessageId: null, mentioned: false };
    const client = new HttpChatClient({ fetchImpl: fetchReturning({ items: [summary] }) });
    const out = await client.listUnread();
    expect(Array.isArray(out)).toBe(true);
    expect(out[0]!.unreadCount).toBe(3);
  });

  it("resolveUsers unwraps a Paginated envelope to an array", async () => {
    const user = { id: "u_1", name: "Ada" };
    const client = new HttpChatClient({ fetchImpl: fetchReturning({ items: [user], nextCursor: null }) });
    const out = await client.resolveUsers(["u_1"]);
    expect(Array.isArray(out)).toBe(true);
    expect(out[0]!.id).toBe("u_1");
  });

  it("resolveUsers short-circuits on empty ids without a request", async () => {
    let called = false;
    const client = new HttpChatClient({
      fetchImpl: (async () => {
        called = true;
        return new Response("[]", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const out = await client.resolveUsers([]);
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });
});
