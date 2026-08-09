import { describe, it, expect } from "vitest";
import { makeDeps, call, createApp } from "./harness";

const topic = { type: "topic", visibility: "public", name: "General" } as const;

async function newChannel(app: ReturnType<typeof createApp>, body: Record<string, unknown> = topic): Promise<string> {
  const r = await call(app, "POST", "/channels", { body });
  return r.json.id as string;
}
async function postN(app: ReturnType<typeof createApp>, channelId: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await call(app, "POST", "/messages", { body: { channelId, body: `m${i}` } });
    ids.push(r.json.id as string);
  }
  return ids;
}

describe("post message", () => {
  it("posts and emits chat.message.created (post-commit) + realtime", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const channelId = await newChannel(app);
    const res = await call(app, "POST", "/messages", { body: { channelId, body: "hello" } });
    expect(res.status).toBe(201);
    expect(res.json.kind).toBe("user");
    expect(res.json.authorId).toBe("user_caller");
    expect(deps.publisher.payloadsFor("chat.message.created")).toContainEqual({
      channelId,
      messageId: res.json.id,
      authorId: "user_caller",
    });
    expect(deps.realtime.kinds()).toContain("message.created");
  });

  it("empty body -> 400; over-long body -> 400", async () => {
    const app = createApp(makeDeps());
    const channelId = await newChannel(app);
    expect((await call(app, "POST", "/messages", { body: { channelId, body: "  " } })).status).toBe(400);
    expect((await call(app, "POST", "/messages", { body: { channelId, body: "x".repeat(20000) } })).status).toBe(400);
  });

  it("posting to an archived channel -> 409 CHAT_CHANNEL_ARCHIVED", async () => {
    const app = createApp(makeDeps());
    const channelId = await newChannel(app);
    await call(app, "PATCH", `/channels/${channelId}`, { body: { version: 1, archived: true } });
    const res = await call(app, "POST", "/messages", { body: { channelId, body: "late" } });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("CHAT_CHANNEL_ARCHIVED");
  });

  it("registers attachment links via file-meta", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const channelId = await newChannel(app);
    const res = await call(app, "POST", "/messages", { body: { channelId, body: "see file", attachmentFileIds: ["file_1"] } });
    expect(res.status).toBe(201);
    expect(deps.fileClient.calls).toContainEqual({ messageId: res.json.id, fileIds: ["file_1"] });
  });
});

describe("threads (1 level)", () => {
  it("threadRootId filters replies; a root from another channel -> 400", async () => {
    const app = createApp(makeDeps());
    const ch1 = await newChannel(app);
    const ch2 = await newChannel(app);
    const root = await call(app, "POST", "/messages", { body: { channelId: ch1, body: "root" } });
    const reply = await call(app, "POST", "/messages", { body: { channelId: ch1, body: "reply", threadRootId: root.json.id } });
    expect(reply.status).toBe(201);

    const thread = await call(app, "GET", "/messages", { query: { channelId: ch1, threadRootId: root.json.id } });
    expect(thread.json.items.map((m: any) => m.id)).toEqual([reply.json.id]);

    const cross = await call(app, "POST", "/messages", { body: { channelId: ch2, body: "x", threadRootId: root.json.id } });
    expect(cross.status).toBe(400);
    expect(cross.json.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("history pagination + gap-fill", () => {
  it("desc cursor walks all messages with no gaps or duplicates", async () => {
    const app = createApp(makeDeps());
    const channelId = await newChannel(app);
    const ids = await postN(app, channelId, 5);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const q: Record<string, string | number> = { channelId, limit: 2 };
      if (cursor) q.cursor = cursor;
      const page = await call(app, "GET", "/messages", { query: q });
      for (const m of page.json.items) seen.push(m.id);
      if (!page.json.nextCursor) break;
      cursor = page.json.nextCursor;
    }
    expect(seen.slice().sort()).toEqual([...ids].sort());
    // newest-first ordering
    expect(seen[0]).toBe(ids[ids.length - 1]);
    expect(new Set(seen).size).toBe(ids.length);
  });

  it("afterMessageId returns later messages in ascending order (gap-fill)", async () => {
    const app = createApp(makeDeps());
    const channelId = await newChannel(app);
    const ids = await postN(app, channelId, 5);
    const page = await call(app, "GET", "/messages", { query: { channelId, afterMessageId: ids[1]! } });
    expect(page.json.items.map((m: any) => m.id)).toEqual(ids.slice(2));
    expect(page.json.nextCursor).toBeNull();
  });

  it("cursor and afterMessageId together -> 400", async () => {
    const app = createApp(makeDeps());
    const channelId = await newChannel(app);
    const res = await call(app, "GET", "/messages", { query: { channelId, cursor: "x", afterMessageId: "y" } });
    expect(res.status).toBe(400);
  });

  it("limit over the max -> 400", async () => {
    const app = createApp(makeDeps());
    const channelId = await newChannel(app);
    const res = await call(app, "GET", "/messages", { query: { channelId, limit: 500 } });
    expect(res.status).toBe(400);
  });
});

describe("edit / delete", () => {
  it("author edits (version bump); non-author edit -> 403; stale version -> 409", async () => {
    const app = createApp(makeDeps());
    const channelId = await newChannel(app, { ...topic, visibility: "private", memberIds: ["user_b"] });
    const m = await call(app, "POST", "/messages", { body: { channelId, body: "orig" } });

    const edit = await call(app, "PATCH", `/messages/${m.json.id}`, { body: { version: 1, body: "edited" } });
    expect(edit.status).toBe(200);
    expect(edit.json.version).toBe(2);
    expect(edit.json.editedAt).not.toBeNull();

    const byOther = await call(app, "PATCH", `/messages/${m.json.id}`, { userId: "user_b", body: { version: 2, body: "hijack" } });
    expect(byOther.status).toBe(403);

    const stale = await call(app, "PATCH", `/messages/${m.json.id}`, { body: { version: 1, body: "x" } });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("CHAT_VERSION_CONFLICT");
  });

  it("delete soft-deletes; history redacts body; emits deleted + audit + realtime", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const channelId = await newChannel(app);
    const m = await call(app, "POST", "/messages", { body: { channelId, body: "secret" } });

    const del = await call(app, "DELETE", `/messages/${m.json.id}`);
    expect(del.status).toBe(204);
    expect(deps.publisher.namesFor("chat.message.deleted")).toHaveLength(1);
    expect(deps.audit.actions()).toContain("chat.message.delete");
    expect(deps.realtime.kinds()).toContain("message.deleted");

    const hist = await call(app, "GET", "/messages", { query: { channelId } });
    const row = hist.json.items.find((x: any) => x.id === m.json.id);
    expect(row.body).toBe("[deleted]");
    expect(row.deletedAt).not.toBeNull();
  });

  it("channel admin (moderator) can delete another user's message", async () => {
    const deps = makeDeps(); // authz grants chat:moderate by default
    const app = createApp(deps);
    const channelId = await newChannel(app, { ...topic, visibility: "private", memberIds: ["user_b"] });
    const m = await call(app, "POST", "/messages", { userId: "user_b", body: { channelId, body: "by b" } });
    const del = await call(app, "DELETE", `/messages/${m.json.id}`); // user_caller is admin
    expect(del.status).toBe(204);
  });
});
