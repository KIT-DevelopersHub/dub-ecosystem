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

describe("HttpChatClient channel delete + sections", () => {
  it("hits the contract paths and handles 204 bodies", async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ method: init.method ?? "GET", url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (init.method === "GET") return new Response(JSON.stringify({ items: [], assignments: {} }), { status: 200 });
      if (init.method === "POST" || init.method === "PATCH") return new Response(JSON.stringify({ id: "s1" }), { status: 200 });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const client = new HttpChatClient({ fetchImpl });
    await client.deleteChannel("ch_1");
    expect(await client.listSections()).toEqual({ items: [], assignments: {} });
    await client.createSection("運営");
    await client.updateSection("s1", { name: "x" });
    await client.deleteSection("s1");
    await client.setChannelSection("ch_1", null);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "DELETE /api/v1/chat/channels/ch_1",
      "GET /api/v1/chat/sections",
      "POST /api/v1/chat/sections",
      "PATCH /api/v1/chat/sections/s1",
      "DELETE /api/v1/chat/sections/s1",
      "PUT /api/v1/chat/channels/ch_1/section",
    ]);
    expect(calls[2]!.body).toEqual({ name: "運営" });
    expect(calls[5]!.body).toEqual({ sectionId: null });
  });
});
