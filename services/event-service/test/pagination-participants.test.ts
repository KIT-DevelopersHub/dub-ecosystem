import { describe, it, expect } from "vitest";
import { makeDeps, call, createApp, FakeTaskClient } from "./harness";

describe("cursor pagination (test #10)", () => {
  it("walks the full set with no gaps or duplicates", async () => {
    const app = createApp(makeDeps());
    for (let i = 0; i < 5; i++) await call(app, "POST", "/events", { body: { title: `E${i}` } });

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const q: Record<string, string | number> = { limit: 2 };
      if (cursor) q.cursor = cursor;
      const page = await call(app, "GET", "/events", { query: q });
      expect(page.status).toBe(200);
      for (const it of page.json.items) seen.push(it.id);
      if (!page.json.nextCursor) break;
      cursor = page.json.nextCursor;
    }
    expect(new Set(seen).size).toBe(5);
    expect(seen).toHaveLength(5);
  });

  it("limit over max (201) -> 400", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "GET", "/events", { query: { limit: 201 } });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("VALIDATION_FAILED");
  });

  it("limit boundary 200 is accepted; 1 works", async () => {
    const app = createApp(makeDeps());
    await call(app, "POST", "/events", { body: { title: "one" } });
    expect((await call(app, "GET", "/events", { query: { limit: 200 } })).status).toBe(200);
    const single = await call(app, "GET", "/events", { query: { limit: 1 } });
    expect(single.json.items).toHaveLength(1);
  });

  it("malformed cursor -> 400", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "GET", "/events", { query: { cursor: "!!!not-base64!!!" } });
    expect(res.status).toBe(400);
  });

  it("startsAfter + sort=startsAt returns ascending order", async () => {
    const app = createApp(makeDeps());
    await call(app, "POST", "/events", { body: { title: "late", startsAt: "2026-12-01T00:00:00.000Z" } });
    await call(app, "POST", "/events", { body: { title: "early", startsAt: "2026-09-01T00:00:00.000Z" } });
    await call(app, "POST", "/events", { body: { title: "mid", startsAt: "2026-10-01T00:00:00.000Z" } });
    const res = await call(app, "GET", "/events", {
      query: { sort: "startsAt", startsAfter: "2026-08-01T00:00:00.000Z" },
    });
    expect(res.json.items.map((x: any) => x.title)).toEqual(["early", "mid", "late"]);
  });
});

describe("participants synthesis (test #13)", () => {
  it("unions event creator, action creators and task assignees, deduped", async () => {
    const deps = makeDeps({ taskClient: new FakeTaskClient(["user_D", "user_A"]) });
    const app = createApp(deps);

    const created = await call(app, "POST", "/events", { userId: "user_A", body: { title: "Ev" } });
    const eventId = created.json.id as string;
    await call(app, "POST", `/events/${eventId}/actions`, { userId: "user_B", body: { kind: "k", title: "b" } });
    await call(app, "POST", `/events/${eventId}/actions`, { userId: "user_C", body: { kind: "k", title: "c" } });

    const res = await call(app, "GET", `/events/${eventId}/participants`, { userId: "user_A" });
    expect(res.status).toBe(200);
    expect([...res.json.userIds].sort()).toEqual(["user_A", "user_B", "user_C", "user_D"]);
  });
});
