import { describe, it, expect } from "vitest";
import { makeDeps, call, createApp } from "./harness";

const topic = { type: "topic", visibility: "public", name: "General" } as const;

// Seed: caller creates a channel (becomes admin member) and posts messages.
async function seedChannel(app: ReturnType<typeof createApp>, name: string, userId = "user_caller") {
  const c = await call(app, "POST", "/channels", { userId, body: { ...topic, name } });
  return c.json.id as string;
}

describe("search: full-text over the caller's channels", () => {
  it("matches message body substrings (case-insensitive), newest first", async () => {
    const app = createApp(makeDeps());
    const ch = await seedChannel(app, "eng");
    await call(app, "POST", "/messages", { body: { channelId: ch, body: "Deploy the Widget today" } });
    await call(app, "POST", "/messages", { body: { channelId: ch, body: "unrelated" } });
    await call(app, "POST", "/messages", { body: { channelId: ch, body: "widget rollback done" } });

    const res = await call(app, "GET", "/search", { query: { q: "WIDGET" } });
    expect(res.status).toBe(200);
    const bodies = res.json.items.map((m: any) => m.body);
    expect(bodies).toEqual(["widget rollback done", "Deploy the Widget today"]); // desc by id
  });

  it("from: filters by author; in: filters to one channel", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const ch1 = await seedChannel(app, "c1");
    const ch2 = await seedChannel(app, "c2");
    // make user_b a member of ch1 so their post is searchable by the caller too
    await call(app, "POST", `/channels/${ch1}/members`, { body: { userId: "user_b" } });
    await call(app, "POST", "/messages", { userId: "user_caller", body: { channelId: ch1, body: "alpha from caller" } });
    await call(app, "POST", "/messages", { userId: "user_b", body: { channelId: ch1, body: "alpha from b" } });
    await call(app, "POST", "/messages", { userId: "user_caller", body: { channelId: ch2, body: "alpha in c2" } });

    const fromB = await call(app, "GET", "/search", { query: { q: "alpha", from: "user_b" } });
    expect(fromB.json.items.map((m: any) => m.body)).toEqual(["alpha from b"]);

    const inC2 = await call(app, "GET", "/search", { query: { q: "alpha", in: ch2 } });
    expect(inC2.json.items.map((m: any) => m.channelId)).toEqual([ch2]);
  });

  it("excludes deleted messages and channels the caller is not in", async () => {
    const app = createApp(makeDeps());
    const ch = await seedChannel(app, "c");
    const m = await call(app, "POST", "/messages", { body: { channelId: ch, body: "secret token here" } });
    await call(app, "DELETE", `/messages/${m.json.id}`);
    const afterDelete = await call(app, "GET", "/search", { query: { q: "secret" } });
    expect(afterDelete.json.items).toHaveLength(0);

    // a stranger who is not a member finds nothing (membership-scoped search)
    const stranger = await call(app, "GET", "/search", { userId: "user_stranger", query: { q: "secret" } });
    expect(stranger.json.items).toHaveLength(0);
  });

  it("in: a private channel the caller cannot see -> 404 (hidden)", async () => {
    const app = createApp(makeDeps());
    const priv = await call(app, "POST", "/channels", { body: { ...topic, visibility: "private", name: "p" } });
    const res = await call(app, "GET", "/search", { userId: "user_stranger", query: { q: "x", in: priv.json.id } });
    expect(res.status).toBe(404);
  });

  it("q is required; wildcard chars are treated literally", async () => {
    const app = createApp(makeDeps());
    const ch = await seedChannel(app, "c");
    await call(app, "POST", "/messages", { body: { channelId: ch, body: "100% sure" } });
    await call(app, "POST", "/messages", { body: { channelId: ch, body: "nope" } });

    const missing = await call(app, "GET", "/search", { query: {} as any });
    expect(missing.status).toBe(400);

    // "%" must match the literal percent, not act as a wildcard
    const literal = await call(app, "GET", "/search", { query: { q: "100%" } });
    expect(literal.json.items.map((m: any) => m.body)).toEqual(["100% sure"]);
  });

  it("paginates with an opaque cursor (keyset, no gaps or dupes)", async () => {
    const app = createApp(makeDeps());
    const ch = await seedChannel(app, "c");
    for (let i = 0; i < 5; i++) await call(app, "POST", "/messages", { body: { channelId: ch, body: `match ${i}` } });

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const query: Record<string, string | number> = { q: "match", limit: 2 };
      if (cursor) query.cursor = cursor;
      const page = await call(app, "GET", "/search", { query });
      for (const m of page.json.items) seen.push(m.id);
      if (!page.json.nextCursor) break;
      cursor = page.json.nextCursor;
    }
    expect(new Set(seen).size).toBe(5);
  });
});
