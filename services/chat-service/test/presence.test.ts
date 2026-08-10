import { describe, it, expect } from "vitest";
import { makeDeps, call, createApp } from "./harness";

describe("presence: set / heartbeat / derived state", () => {
  it("a fresh heartbeat reads as active; a manual 'away' overrides freshness", async () => {
    const app = createApp(makeDeps());
    const active = await call(app, "PUT", "/presence", { body: {} }); // heartbeat only
    expect(active.status).toBe(200);
    expect(active.json.state).toBe("active");

    const away = await call(app, "PUT", "/presence", { body: { presence: "away" } });
    expect(away.json.state).toBe("away");
  });

  it("goes 'away' once the last heartbeat is older than the active window", async () => {
    let clock = "2026-08-09T00:00:00.000Z";
    const app = createApp(makeDeps({ now: () => clock }));
    await call(app, "PUT", "/presence", { body: { presence: "auto" } });

    // read now: still fresh
    const fresh = await call(app, "GET", "/presence", { query: { userIds: "user_caller" } });
    expect(fresh.json.items[0].state).toBe("active");

    // advance 10 minutes past the last heartbeat -> stale -> away
    clock = "2026-08-09T00:10:00.000Z";
    const stale = await call(app, "GET", "/presence", { query: { userIds: "user_caller" } });
    expect(stale.json.items[0].state).toBe("away");
  });

  it("stores status emoji/text and clears them past statusExpiresAt", async () => {
    let clock = "2026-08-09T00:00:00.000Z";
    const app = createApp(makeDeps({ now: () => clock }));
    await call(app, "PUT", "/presence", {
      body: { statusEmoji: ":palm_tree:", statusText: "on vacation", statusExpiresAt: "2026-08-09T00:05:00.000Z" },
    });

    const before = await call(app, "GET", "/presence", { query: { userIds: "user_caller" } });
    expect(before.json.items[0].statusEmoji).toBe(":palm_tree:");
    expect(before.json.items[0].statusText).toBe("on vacation");

    clock = "2026-08-09T00:06:00.000Z"; // past expiry
    const after = await call(app, "GET", "/presence", { query: { userIds: "user_caller" } });
    expect(after.json.items[0].statusEmoji).toBeNull();
    expect(after.json.items[0].statusText).toBeNull();
  });

  it("batch read returns a row per requested user; unknown users read as away/never-seen", async () => {
    const app = createApp(makeDeps());
    await call(app, "PUT", "/presence", { userId: "user_a", body: { presence: "auto" } });
    const res = await call(app, "GET", "/presence", { userId: "user_a", query: { userIds: "user_a,user_ghost" } });
    expect(res.json.items).toHaveLength(2);
    const ghost = res.json.items.find((p: any) => p.userId === "user_ghost");
    expect(ghost).toMatchObject({ state: "away", statusEmoji: null, lastActiveAt: null });
  });

  it("validates: bad presence value -> 400; empty userIds -> 400", async () => {
    const app = createApp(makeDeps());
    const bad = await call(app, "PUT", "/presence", { body: { presence: "invisible" } });
    expect(bad.status).toBe(400);
    const empty = await call(app, "GET", "/presence", { query: { userIds: " , " } });
    expect(empty.status).toBe(400);
  });

  it("requires authentication", async () => {
    const app = createApp(makeDeps());
    const res = await call(app, "PUT", "/presence", { userId: null, body: {} });
    expect(res.status).toBe(401);
  });
});
