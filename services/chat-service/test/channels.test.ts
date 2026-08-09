import { describe, it, expect } from "vitest";
import { makeDeps, call, createApp, fakeAuthz } from "./harness";
import type { identity } from "@dub/types";

const topic = { type: "topic", visibility: "public", name: "General" } as const;

describe("channel create", () => {
  it("creates a channel; creator becomes an admin member; emits channel.created + audit", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const res = await call(app, "POST", "/channels", { body: topic });
    expect(res.status).toBe(201);
    expect(res.json.version).toBe(1);
    expect(res.json.type).toBe("topic");

    const detail = await call(app, "GET", `/channels/${res.json.id}`);
    expect(detail.status).toBe(200);
    expect(detail.json.membership.role).toBe("admin");
    expect(deps.publisher.namesFor("chat.channel.created")).toHaveLength(1);
    expect(deps.audit.actions()).toContain("chat.channel.created");
  });

  it("event-type channel requires an eventId and existence check", async () => {
    const app = createApp(makeDeps());
    const missing = await call(app, "POST", "/channels", { body: { type: "event", visibility: "public", name: "E" } });
    expect(missing.status).toBe(400);

    const app2 = createApp(makeDeps({ eventClient: { async eventExists() { return false; } } }));
    const notFound = await call(app2, "POST", "/channels", { body: { type: "event", visibility: "public", name: "E", eventId: "event_x" } });
    expect(notFound.status).toBe(404);
  });

  it("POST /channels requires chat:create permission", async () => {
    const deps = makeDeps({ authz: fakeAuthz(new Set<identity.PermissionKey>([])) });
    const app = createApp(deps);
    const res = await call(app, "POST", "/channels", { body: topic });
    expect(res.status).toBe(403);
  });

  it("initial memberIds are added and emit member.added + realtime", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const res = await call(app, "POST", "/channels", { body: { ...topic, visibility: "private", memberIds: ["user_b"] } });
    expect(res.status).toBe(201);
    // user_b can now view the private channel
    const seen = await call(app, "GET", `/channels/${res.json.id}`, { userId: "user_b" });
    expect(seen.status).toBe(200);
    expect(deps.publisher.payloadsFor("chat.member.added")).toContainEqual({ channelId: res.json.id, userId: "user_b", change: "added" });
    expect(deps.realtime.kinds()).toContain("member.added");
  });
});

describe("channel visibility / existence hiding", () => {
  it("private channel: non-member GET -> 404 (hidden)", async () => {
    const app = createApp(makeDeps());
    const c = await call(app, "POST", "/channels", { body: { ...topic, visibility: "private" } });
    const other = await call(app, "GET", `/channels/${c.json.id}`, { userId: "user_stranger" });
    expect(other.status).toBe(404);
  });

  it("public channel: non-member GET -> 200 with membership null", async () => {
    const app = createApp(makeDeps());
    const c = await call(app, "POST", "/channels", { body: topic });
    const other = await call(app, "GET", `/channels/${c.json.id}`, { userId: "user_stranger" });
    expect(other.status).toBe(200);
    expect(other.json.membership).toBeNull();
  });
});

describe("channel list pagination (keyset by id)", () => {
  it("walks visible channels with no gaps or duplicates", async () => {
    const app = createApp(makeDeps());
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await call(app, "POST", "/channels", { body: { ...topic, name: `c${i}` } });
      ids.push(c.json.id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const q: Record<string, string | number> = { limit: 2 };
      if (cursor) q.cursor = cursor;
      const page = await call(app, "GET", "/channels", { query: q });
      for (const c of page.json.items) seen.push(c.id);
      if (!page.json.nextCursor) break;
      cursor = page.json.nextCursor;
    }
    expect(seen.sort()).toEqual([...ids].sort());
  });

  it("?eventId= filters to that event's channels", async () => {
    const app = createApp(makeDeps());
    await call(app, "POST", "/channels", { body: { type: "event", visibility: "public", name: "E1", eventId: "event_1" } });
    await call(app, "POST", "/channels", { body: topic });
    const page = await call(app, "GET", "/channels", { query: { eventId: "event_1" } });
    expect(page.json.items).toHaveLength(1);
    expect(page.json.items[0].eventId).toBe("event_1");
  });
});

describe("channel update / archive (optimistic lock)", () => {
  it("patch name with correct version bumps version; stale version -> 409 CHAT_VERSION_CONFLICT", async () => {
    const app = createApp(makeDeps());
    const c = await call(app, "POST", "/channels", { body: topic });
    const ok = await call(app, "PATCH", `/channels/${c.json.id}`, { body: { version: 1, name: "Renamed" } });
    expect(ok.status).toBe(200);
    expect(ok.json.version).toBe(2);
    expect(ok.json.name).toBe("Renamed");

    const stale = await call(app, "PATCH", `/channels/${c.json.id}`, { body: { version: 1, name: "X" } });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("CHAT_VERSION_CONFLICT");
  });

  it("archiving is audited and reflected in the channel", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const c = await call(app, "POST", "/channels", { body: topic });
    const arch = await call(app, "PATCH", `/channels/${c.json.id}`, { body: { version: 1, archived: true } });
    expect(arch.status).toBe(200);
    expect(arch.json.archivedAt).not.toBeNull();
    expect(deps.audit.actions()).toContain("chat.channel.archive");
  });

  it("non-admin, non-moderator cannot add members -> 403", async () => {
    // caller creates channel; a plain member without moderate tries to add.
    const deps = makeDeps();
    const app = createApp(deps);
    const c = await call(app, "POST", "/channels", { body: { ...topic, visibility: "private", memberIds: ["user_b"] } });

    // rebuild app with authz that grants nothing (user_b is member role member)
    const deps2 = makeDeps({ repo: deps.repo, authz: fakeAuthz(new Set<identity.PermissionKey>([])) });
    const app2 = createApp(deps2);
    const res = await call(app2, "POST", `/channels/${c.json.id}/members`, { userId: "user_b", body: { userId: "user_c" } });
    expect(res.status).toBe(403);
  });
});

describe("membership add / remove events", () => {
  it("add member emits chat.member.added; self-remove emits chat.member.removed", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const c = await call(app, "POST", "/channels", { body: { ...topic, visibility: "private" } });

    const add = await call(app, "POST", `/channels/${c.json.id}/members`, { body: { userId: "user_b" } });
    expect(add.status).toBe(204);
    expect(deps.publisher.namesFor("chat.member.added")).toHaveLength(1);

    // user_b removes self
    const del = await call(app, "DELETE", `/channels/${c.json.id}/members/user_b`, { userId: "user_b" });
    expect(del.status).toBe(204);
    expect(deps.publisher.namesFor("chat.member.removed")).toHaveLength(1);
  });
});
