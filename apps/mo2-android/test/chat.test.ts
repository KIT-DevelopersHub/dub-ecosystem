import { describe, it, expect, vi } from "vitest";
import { MobileBffClient } from "../src/bff-client";
import { ChatRepository, type ChatRealtimeTransport } from "../src/chat";
import { InMemorySessionStore } from "../src/session-store";
import type { FetchFn } from "../src/http";
import { makeMockServer, errorBody, type MockServer } from "./helpers";

function makeClient(server: MockServer) {
  const store = new InMemorySessionStore();
  store.setSession("tok_1", "r_1");
  return new MobileBffClient({ fetchFn: server.fetch, store, onLogout: vi.fn() });
}

function repoOf(server: MockServer, transport?: ChatRealtimeTransport) {
  let n = 0;
  return new ChatRepository(makeClient(server), {
    transport,
    now: () => "2026-08-09T00:00:00Z",
    localId: () => `local_${++n}`,
  });
}

const msg = (id: string, body: string, authorId = "usr_1", channelId = "chn_1") => ({
  id,
  channelId,
  authorId,
  body,
  createdAt: "2026-08-09T00:00:00Z",
});

describe("ChatRepository — S10 channels + messages", () => {
  it("loadChannels populates cache and notifies subscribers", async () => {
    const server = makeMockServer({
      status: 200,
      body: { items: [{ id: "chn_1", name: "general", createdAt: "2026-08-09T00:00:00Z" }], nextCursor: null },
    });
    const repo = repoOf(server);
    const seen: number[] = [];
    repo.subscribeChannels((c) => seen.push(c.length));
    await repo.loadChannels();
    expect(repo.observeChannels()).toHaveLength(1);
    expect(repo.observeChannels()[0]!.name).toBe("general");
    expect(seen).toEqual([1]);
    expect(server.requests[0]!.url).toContain("/m/v1/chat/channels");
  });

  it("loadMessages populates entries as sent", async () => {
    const server = makeMockServer({
      status: 200,
      body: { items: [msg("m1", "hi"), msg("m2", "yo")], nextCursor: null },
    });
    const repo = repoOf(server);
    await repo.loadMessages("chn_1");
    const entries = repo.observeMessages("chn_1");
    expect(entries.map((e) => e.state)).toEqual(["sent", "sent"]);
    expect(entries.map((e) => e.message.body)).toEqual(["hi", "yo"]);
    expect(server.requests[0]!.url).toContain("/m/v1/chat/channels/chn_1/messages");
  });
});

describe("ChatRepository — optimistic send", () => {
  it("shows pending immediately, then promotes to the server message on ack", async () => {
    const server = makeMockServer({ status: 200, body: msg("m_server", "hello") });
    const repo = repoOf(server);

    const pending = repo.sendMessage("chn_1", "usr_1", "hello");
    // optimistic row is visible synchronously with a local id
    const mid = repo.observeMessages("chn_1");
    expect(mid).toHaveLength(1);
    expect(mid[0]!.state).toBe("pending");
    expect(mid[0]!.localId).toBe("local_1");
    expect(mid[0]!.message.id).toBe("local_1");

    const res = await pending;
    expect(res).toEqual({ ok: true, message: msg("m_server", "hello") });
    const after = repo.observeMessages("chn_1");
    expect(after).toHaveLength(1); // promoted in place, not duplicated
    expect(after[0]!.state).toBe("sent");
    expect(after[0]!.message.id).toBe("m_server");
    expect(after[0]!.localId).toBeUndefined();
    expect(server.requests[0]!.method).toBe("POST");
    expect(server.requests[0]!.body).toEqual({ body: "hello" });
  });

  it("marks the row failed and returns the error when the POST fails", async () => {
    const server = makeMockServer({ status: 500, body: errorBody("INTERNAL") });
    const repo = repoOf(server);
    const res = await repo.sendMessage("chn_1", "usr_1", "oops");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.kind).toBe("Server");
      expect(res.localId).toBe("local_1");
    }
    const entries = repo.observeMessages("chn_1");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.state).toBe("failed"); // retained for retry
  });
});

describe("ChatRepository — realtime reconcile", () => {
  it("message.created appends and is idempotent (dedupe by id)", async () => {
    const server = makeMockServer();
    const repo = repoOf(server);
    repo.applyRealtimeEvent({ kind: "message.created", channelId: "chn_1", messageId: "m1", authorId: "usr_2", body: "hey", at: "2026-08-09T00:00:00Z" });
    repo.applyRealtimeEvent({ kind: "message.created", channelId: "chn_1", messageId: "m1", authorId: "usr_2", body: "hey", at: "2026-08-09T00:00:00Z" });
    const entries = repo.observeMessages("chn_1");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message.id).toBe("m1");
    expect(entries[0]!.state).toBe("sent");
  });

  it("message.created promotes a matching pending optimistic row (no duplicate)", async () => {
    // POST is held open so the row stays "pending" when realtime arrives first.
    let resolvePost!: (r: Response) => void;
    const fetchFn: FetchFn = (_url, init) => {
      if (init.method === "POST") return new Promise<Response>((r) => (resolvePost = r));
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    const store = new InMemorySessionStore();
    store.setSession("tok_1", "r_1");
    const client = new MobileBffClient({ fetchFn, store, onLogout: vi.fn() });
    let n = 0;
    const repo = new ChatRepository(client, { now: () => "2026-08-09T00:00:00Z", localId: () => `local_${++n}` });

    const pending = repo.sendMessage("chn_1", "usr_1", "hello");
    expect(repo.observeMessages("chn_1")[0]!.state).toBe("pending");

    // server broadcasts the same message over the WS before the POST response lands
    repo.applyRealtimeEvent({ kind: "message.created", channelId: "chn_1", messageId: "m_real", authorId: "usr_1", body: "hello", at: "2026-08-09T00:00:00Z" });
    let entries = repo.observeMessages("chn_1");
    expect(entries).toHaveLength(1); // promoted in place
    expect(entries[0]!.message.id).toBe("m_real");
    expect(entries[0]!.state).toBe("sent");

    // now the POST ack (same id) resolves -> still exactly one row
    resolvePost(new Response(JSON.stringify(msg("m_real", "hello")), { status: 200 }));
    await pending;
    entries = repo.observeMessages("chn_1");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message.id).toBe("m_real");
  });

  it("message.deleted removes the message", async () => {
    const server = makeMockServer();
    const repo = repoOf(server);
    repo.applyRealtimeEvent({ kind: "message.created", channelId: "chn_1", messageId: "m1", authorId: "usr_2", body: "hey", at: "2026-08-09T00:00:00Z" });
    repo.applyRealtimeEvent({ kind: "message.deleted", channelId: "chn_1", messageId: "m1", at: "2026-08-09T00:01:00Z" });
    expect(repo.observeMessages("chn_1")).toHaveLength(0);
  });

  it("member.added / member.removed are no-ops for the message store", async () => {
    const server = makeMockServer();
    const repo = repoOf(server);
    repo.applyRealtimeEvent({ kind: "member.added", channelId: "chn_1", userId: "usr_3", at: "2026-08-09T00:00:00Z" });
    repo.applyRealtimeEvent({ kind: "member.removed", channelId: "chn_1", userId: "usr_3", at: "2026-08-09T00:00:00Z" });
    expect(repo.observeMessages("chn_1")).toHaveLength(0);
  });
});

describe("ChatRepository — injected WS transport", () => {
  it("connectRealtime wires the injected transport and disconnect stops delivery", async () => {
    const server = makeMockServer();
    let handler: ((e: any) => void) | null = null;
    const disconnect = vi.fn();
    const transport: ChatRealtimeTransport = {
      connect: (_channelId, onEvent) => {
        handler = onEvent;
        return disconnect;
      },
    };
    const repo = repoOf(server, transport);
    const stop = repo.connectRealtime("chn_1");
    expect(handler).not.toBeNull();

    handler!({ kind: "message.created", channelId: "chn_1", messageId: "m1", authorId: "usr_2", body: "via ws", at: "2026-08-09T00:00:00Z" });
    expect(repo.observeMessages("chn_1")).toHaveLength(1);
    expect(repo.observeMessages("chn_1")[0]!.message.body).toBe("via ws");

    stop();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("connectRealtime is a no-op when no transport is injected", () => {
    const repo = repoOf(makeMockServer());
    expect(() => repo.connectRealtime("chn_1")()).not.toThrow();
  });
});
