import { describe, it, expect } from "vitest";
import { HDR_INTERNAL } from "@dub/observability";
import type { gateway } from "@dub/types";
import { createApp } from "../src/app";
import { fakeBinding, authBinding, validSession, json, makeEnv, execCtx } from "./helpers";

const NO_RL = { rateLimiter: { check: async () => ({ allowed: true, limit: 1e9, remaining: 1e9, retryAfterSec: 0, resetEpochSec: 0 }) } };
const app = () => createApp(NO_RL);

function identityForMe() {
  return fakeBinding((req) => {
    const path = new URL(req.url).pathname;
    if (path === "/users/usr_1") {
      return json(200, {
        id: "usr_1",
        orgId: "org_devhub",
        displayName: "Alice",
        email: "alice@example.com",
        githubLogin: "alice",
        avatarUrl: null,
        status: "active",
        roleIds: ["role_admin"],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
    }
    if (path === "/internal/users/usr_1/permissions") {
      return json(200, { permissions: ["event:read", "task:write"] });
    }
    return json(404, { error: { code: "NOT_FOUND", message: "no", retryable: false } });
  });
}

describe("GET /api/v1/me", () => {
  it("[case10] composes identity master + internal permissions into MeResponse", async () => {
    const identity = identityForMe();
    const env = makeEnv({ SVC_AUTH: authBinding(validSession("usr_1", 1_800_000_000_000)).fetcher, SVC_IDENTITY: identity.fetcher });

    const res = await app().fetch(new Request("https://x/api/v1/me", { headers: { authorization: "Bearer t" } }), env, execCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as gateway.MeResponse;
    expect(body.user).toEqual({ id: "usr_1", displayName: "Alice", avatarUrl: null, email: "alice@example.com" });
    expect(body.orgId).toBe("org_devhub");
    expect(body.permissions).toEqual(["event:read", "task:write"]);
    expect(body.sessionExpiresAt).toBe(1_800_000_000_000);

    // internal permissions call must carry x-dub-internal (genuine service-to-service)
    const internalReq = identity.requests.find((r) => new URL(r.url).pathname === "/internal/users/usr_1/permissions");
    expect(internalReq?.headers.get(HDR_INTERNAL)).toBe("1");
  });

  it("[case10] requires auth", async () => {
    const env = makeEnv({ SVC_AUTH: authBinding({ valid: false, userId: null, session: null, reason: "malformed" }).fetcher });
    const res = await app().fetch(new Request("https://x/api/v1/me", { headers: { authorization: "Bearer bad" } }), env, execCtx);
    expect(res.status).toBe(401);
  });
});
