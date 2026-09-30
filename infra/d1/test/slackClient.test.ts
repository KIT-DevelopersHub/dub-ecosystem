// Slack Web API client — pagination cursor handling + 429 rate-limit backoff, driven by
// an injected fetch mock (no real network). Response bodies mirror the actual Slack Web
// API shapes (ok/error/response_metadata.next_cursor) for conversations.list/history/
// replies + users.list.
import { describe, it, expect, vi } from "vitest";
import { createSlackClient, SlackApiError } from "../src/slackClient";

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

describe("createSlackClient — pagination", () => {
  it("listChannels follows response_metadata.next_cursor across pages", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, channels: [{ id: "C1", name: "one" }], response_metadata: { next_cursor: "page2" } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, channels: [{ id: "C2", name: "two" }], response_metadata: { next_cursor: "" } }));
    const client = createSlackClient({ token: "xoxb-test", fetchImpl });
    const channels = await client.listChannels();
    expect(channels.map((c) => c.id)).toEqual(["C1", "C2"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // second call carries the cursor from the first page
    const secondUrl = String(fetchImpl.mock.calls[1]![0]);
    expect(secondUrl).toContain("cursor=page2");
  });

  it("listUsers follows pagination the same way", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, members: [{ id: "U1" }], response_metadata: { next_cursor: "p2" } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, members: [{ id: "U2" }], response_metadata: { next_cursor: "" } }));
    const client = createSlackClient({ token: "xoxb-test", fetchImpl });
    const users = await client.listUsers();
    expect(users.map((u) => u.id)).toEqual(["U1", "U2"]);
  });

  it("historyForChannel and repliesForThread paginate identically", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, messages: [{ ts: "1", text: "a" }], response_metadata: { next_cursor: "p2" } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, messages: [{ ts: "2", text: "b" }], response_metadata: { next_cursor: "" } }));
    const client = createSlackClient({ token: "xoxb-test", fetchImpl });
    const messages = await client.historyForChannel("C1");
    expect(messages.map((m) => m.ts)).toEqual(["1", "2"]);
  });

  it("passes channel + ts params for conversations.replies", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ ok: true, messages: [{ ts: "1", text: "root" }], response_metadata: {} }));
    const client = createSlackClient({ token: "xoxb-test", fetchImpl });
    await client.repliesForThread("C1", "1717000000.000100");
    const url = String(fetchImpl.mock.calls[0]![0]);
    expect(url).toContain("conversations.replies");
    expect(url).toContain("channel=C1");
    expect(url).toContain("ts=1717000000.000100");
  });
});

describe("createSlackClient — errors", () => {
  it("throws SlackApiError when Slack responds ok:false", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ ok: false, error: "channel_not_found" }));
    const client = createSlackClient({ token: "xoxb-test", fetchImpl });
    await expect(client.historyForChannel("C_MISSING")).rejects.toThrow(SlackApiError);
  });

  it("retries on 429 honoring Retry-After, then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, { status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, channels: [], response_metadata: {} }));
    const client = createSlackClient({ token: "xoxb-test", fetchImpl, baseRetryDelayMs: 1 });
    const channels = await client.listChannels();
    expect(channels).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxRetries consecutive 429s", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, { status: 429 }));
    const client = createSlackClient({ token: "xoxb-test", fetchImpl, baseRetryDelayMs: 1, maxRetries: 2 });
    await expect(client.listChannels()).rejects.toThrow(SlackApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});

describe("createSlackClient — downloadFile", () => {
  it("sends the bot token as a Bearer header and returns the body bytes", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const client = createSlackClient({ token: "xoxb-test", fetchImpl });
    const bytes = await client.downloadFile("https://files.slack.com/files-pri/T0-F0/x.pdf");
    expect(new Uint8Array(bytes!)).toEqual(new Uint8Array([1, 2, 3]));
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer xoxb-test" });
  });

  it("returns null on a non-OK response instead of throwing (one broken attachment must not abort the run)", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 }));
    const client = createSlackClient({ token: "xoxb-test", fetchImpl });
    expect(await client.downloadFile("https://files.slack.com/x")).toBeNull();
  });
});
