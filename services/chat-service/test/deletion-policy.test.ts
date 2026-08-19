// Message deletion policy: GET/PUT the org-scoped policy and the resolved delete
// behaviour per privilege tier (member vs moderator). Uses a tiered authz fake so a
// plain member and a chat:moderate holder can be distinguished per request — the
// InMemory harness authz grants a fixed set to everyone, which cannot express tiers.
import { describe, it, expect } from "vitest";
import type { MiddlewareHandler } from "hono";
import { DubError, CommonErrorCodes } from "@dub/errors";
import { makeDeps, call, createApp } from "./harness";
import type { Authz } from "../src/types";

const publicTopic = { type: "topic", visibility: "public", name: "General" } as const;
const POLICY_PATH = "/chat/settings/deletion-policy";

// chat:moderate is granted only to `moderators`; every other permission is open.
function tieredAuthz(moderators: Set<string>): Authz {
  return {
    requireAuth(): MiddlewareHandler {
      return async (c, next) => {
        if (!c.req.header("x-dub-user-id")) throw new DubError("AUTH_INVALID_TOKEN", "x-dub-user-id absent", { status: 401 });
        await next();
      };
    },
    requirePermission(permission): MiddlewareHandler {
      return async (c, next) => {
        const uid = c.req.header("x-dub-user-id") ?? "";
        const ok = permission === "chat:moderate" ? moderators.has(uid) : true;
        if (!ok) throw new DubError(CommonErrorCodes.FORBIDDEN, `permission denied: ${permission}`, { status: 403 });
        await next();
      };
    },
    async hasPermission(userId, _orgId, query) {
      return query.permission === "chat:moderate" ? moderators.has(userId) : true;
    },
  };
}

describe("deletion policy: read + write", () => {
  it("GET returns the all-hard default at version 0 until overridden", async () => {
    const app = createApp(makeDeps({ authz: tieredAuthz(new Set()) }));
    const res = await call(app, "GET", POLICY_PATH, { userId: "user_x" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ policy: { member: "hard", moderator: "hard" }, version: 0 });
  });

  it("PUT requires chat:moderate (fail-close), validates modes, and is version-locked", async () => {
    const app = createApp(makeDeps({ authz: tieredAuthz(new Set(["user_admin"])) }));

    // non-moderator -> 403
    const denied = await call(app, "PATCH", POLICY_PATH, {
      userId: "user_member",
      body: { version: 0, policy: { member: "tombstone", moderator: "hard" } },
    });
    expect(denied.status).toBe(403);

    // moderator sets it (first write: version 0 -> 1)
    const ok = await call(app, "PATCH", POLICY_PATH, {
      userId: "user_admin",
      body: { version: 0, policy: { member: "tombstone", moderator: "hard" } },
    });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ policy: { member: "tombstone", moderator: "hard" }, version: 1 });

    // stale version -> 409
    const stale = await call(app, "PATCH", POLICY_PATH, {
      userId: "user_admin",
      body: { version: 0, policy: { member: "hard", moderator: "hard" } },
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("CHAT_VERSION_CONFLICT");

    // invalid mode -> 400
    const bad = await call(app, "PATCH", POLICY_PATH, {
      userId: "user_admin",
      body: { version: 1, policy: { member: "nope", moderator: "hard" } },
    });
    expect(bad.status).toBe(400);
  });
});

describe("deletion policy: resolved delete behaviour", () => {
  it("member-tier tombstones its own message; moderator-tier hard-erases (policy split)", async () => {
    const deps = makeDeps({ authz: tieredAuthz(new Set(["user_admin"])) });
    const app = createApp(deps);

    // admin creates the channel so the member is NOT a channel admin (stays member-tier).
    const ch = await call(app, "POST", "/chat/channels", { userId: "user_admin", body: publicTopic });
    const channelId = ch.json.id as string;

    // split policy: member = tombstone, moderator = hard
    const put = await call(app, "PATCH", POLICY_PATH, {
      userId: "user_admin",
      body: { version: 0, policy: { member: "tombstone", moderator: "hard" } },
    });
    expect(put.status).toBe(200);

    // member deletes own message -> tombstone (redacted in place, stays in history)
    const mm = await call(app, "POST", "/chat/messages", { userId: "user_member", body: { channelId, body: "mine" } });
    const delM = await call(app, "DELETE", `/chat/messages/${mm.json.id}`, { userId: "user_member" });
    expect(delM.status).toBe(200);
    expect(delM.json.mode).toBe("tombstone");
    expect(delM.json.message).toMatchObject({ id: mm.json.id, body: "[deleted]" });
    const histT = await call(app, "GET", "/chat/messages", { userId: "user_member", query: { channelId } });
    expect(histT.json.items.find((x: any) => x.id === mm.json.id)).toMatchObject({ body: "[deleted]" });
    const rtT = deps.realtime.events.at(-1)!.event;
    expect(rtT).toMatchObject({ kind: "message.deleted", mode: "tombstone" });

    // moderator deletes a member's message -> hard erase (gone from history)
    const mm2 = await call(app, "POST", "/chat/messages", { userId: "user_member", body: { channelId, body: "delete me" } });
    const delA = await call(app, "DELETE", `/chat/messages/${mm2.json.id}`, { userId: "user_admin" });
    expect(delA.status).toBe(200);
    expect(delA.json.mode).toBe("hard");
    expect(delA.json.message).toBeNull();
    const histH = await call(app, "GET", "/chat/messages", { userId: "user_admin", query: { channelId } });
    expect(histH.json.items.find((x: any) => x.id === mm2.json.id)).toBeUndefined();
  });

  it("a non-author non-moderator cannot delete another user's message (403)", async () => {
    const app = createApp(makeDeps({ authz: tieredAuthz(new Set(["user_admin"])) }));
    const ch = await call(app, "POST", "/chat/channels", { userId: "user_admin", body: publicTopic });
    const m = await call(app, "POST", "/chat/messages", { userId: "user_member", body: { channelId: ch.json.id, body: "hi" } });
    const del = await call(app, "DELETE", `/chat/messages/${m.json.id}`, { userId: "user_other" });
    expect(del.status).toBe(403);
  });
});
