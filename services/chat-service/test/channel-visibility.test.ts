import { describe, it, expect } from "vitest";
import type { identity } from "@dub/types";
import { makeDeps, call, createApp, fakeAuthz, ALL_CHAT_KEYS } from "./harness";

const WITH_VISIBILITY = new Set<identity.PermissionKey>([...ALL_CHAT_KEYS, "chat:change_visibility"]);
const OUTSIDER = { userId: "user_outsider" };

describe("PUT /chat/channels/:id/visibility", () => {
  it("public -> private hides the channel from non-members, evicts their sockets and audits", async () => {
    const deps = makeDeps({ authz: fakeAuthz(WITH_VISIBILITY) });
    const app = createApp(deps);
    const ch = await call(app, "POST", "/chat/channels", { body: { type: "topic", visibility: "public", name: "General" } });
    expect((await call(app, "GET", `/chat/channels/${ch.json.id}`, OUTSIDER)).status).toBe(200);

    const res = await call(app, "PUT", `/chat/channels/${ch.json.id}/visibility`, { body: { visibility: "private", version: ch.json.version } });
    expect(res.status).toBe(200);
    expect(res.json.visibility).toBe("private");
    expect(res.json.version).toBe(ch.json.version + 1);
    expect((await call(app, "GET", `/chat/channels/${ch.json.id}`, OUTSIDER)).status).toBe(404);
    expect((await call(app, "GET", `/chat/channels/${ch.json.id}`)).status).toBe(200); // creator stays a member
    expect(deps.realtime.evicted).toEqual([{ channelId: ch.json.id, memberIds: ["user_caller"] }]);
    expect(deps.audit.actions()).toContain("chat.channel.visibility");
  });

  it("private -> public opens the channel to everyone without evicting anyone", async () => {
    const deps = makeDeps({ authz: fakeAuthz(WITH_VISIBILITY) });
    const app = createApp(deps);
    const ch = await call(app, "POST", "/chat/channels", { body: { type: "topic", visibility: "private", name: "運営" } });
    expect((await call(app, "GET", `/chat/channels/${ch.json.id}`, OUTSIDER)).status).toBe(404);

    const res = await call(app, "PUT", `/chat/channels/${ch.json.id}/visibility`, { body: { visibility: "public", version: ch.json.version } });
    expect(res.status).toBe(200);
    expect((await call(app, "GET", `/chat/channels/${ch.json.id}`, OUTSIDER)).status).toBe(200);
    expect(deps.realtime.evicted).toEqual([]);
  });

  it("requires chat:change_visibility even for the channel admin / moderator", async () => {
    const app = createApp(makeDeps()); // ALL_CHAT_KEYS: edit + create + moderate, no visibility key
    const ch = await call(app, "POST", "/chat/channels", { body: { type: "topic", visibility: "public", name: "General" } });
    const res = await call(app, "PUT", `/chat/channels/${ch.json.id}/visibility`, { body: { visibility: "private", version: ch.json.version } });
    expect(res.status).toBe(403);
    expect(res.json.error.details.missing).toEqual(["chat:change_visibility"]);
    expect((await call(app, "GET", `/chat/channels/${ch.json.id}`)).json.channel.visibility).toBe("public");
  });

  it("rejects DMs, bad values and stale versions; same value is a no-op; hidden channels 404", async () => {
    const app = createApp(makeDeps({ authz: fakeAuthz(WITH_VISIBILITY) }));
    const dm = await call(app, "POST", "/chat/channels", { body: { type: "dm", visibility: "private", name: "dm", memberIds: ["user_b"] } });
    expect((await call(app, "PUT", `/chat/channels/${dm.json.id}/visibility`, { body: { visibility: "public", version: dm.json.version } })).status).toBe(400);

    const ch = await call(app, "POST", "/chat/channels", { body: { type: "topic", visibility: "private", name: "運営" } });
    const path = `/chat/channels/${ch.json.id}/visibility`;
    expect((await call(app, "PUT", path, { body: { visibility: "secret", version: ch.json.version } })).status).toBe(400);
    expect((await call(app, "PUT", path, { body: { visibility: "public", version: ch.json.version + 5 } })).status).toBe(409);
    const same = await call(app, "PUT", path, { body: { visibility: "private", version: ch.json.version } });
    expect(same.status).toBe(200);
    expect(same.json.version).toBe(ch.json.version);
    expect((await call(app, "PUT", path, { ...OUTSIDER, body: { visibility: "public", version: ch.json.version } })).status).toBe(404);
  });
});
