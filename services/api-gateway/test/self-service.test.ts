// Gateway-owned self-service (アカウント設定): GET/POST /api/v1/me/profile forwards to
// identity-roster (self display name/avatar); GET/POST /api/v1/me/participation forwards to
// member-service (self 参加届). Both compose entry-verify + a genuine internal s2s forward
// scoped to the caller's session id — asserted here over faked service bindings.
import { describe, it, expect } from "vitest";
import { HDR_INTERNAL } from "@dub/observability";
import type { gateway, member } from "@dub/types";
import { createApp } from "../src/app";
import { fakeBinding, authBinding, validSession, json, makeEnv, execCtx } from "./helpers";

const NO_RL = { rateLimiter: { check: async () => ({ allowed: true, limit: 1e9, remaining: 1e9, retryAfterSec: 0, resetEpochSec: 0 }) } };
const app = () => createApp(NO_RL);
const auth = () => authBinding(validSession("usr_1", 1_800_000_000_000)).fetcher;

const IDENTITY_USER = {
  id: "usr_1",
  orgId: "org_devhub",
  displayName: "Alice",
  email: "alice@example.com",
  githubLogin: null,
  avatarUrl: "data:image/png;base64,AAAA",
  status: "active",
  roleIds: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const SELF_PART: member.SelfParticipation = {
  lastName: "山田",
  firstName: "太郎",
  lastNameKana: "やまだ",
  firstNameKana: "たろう",
  lastNameRomaji: "Yamada",
  firstNameRomaji: "Taro",
  schoolEmail: "taro@school.ac.jp",
  gmail: "taro@gmail.com",
  phone: "090-1111-2222",
  grade: "3",
  department: "情報工学科",
  desiredActivity: "dev",
  note: null,
};

describe("GET/POST /api/v1/me/profile", () => {
  it("GET reads the caller's own display name + avatar from identity", async () => {
    const identity = fakeBinding((req) =>
      new URL(req.url).pathname === "/users/usr_1"
        ? json(200, IDENTITY_USER)
        : json(404, { error: { code: "NOT_FOUND", message: "no", retryable: false } }),
    );
    const env = makeEnv({ SVC_AUTH: auth(), SVC_IDENTITY: identity.fetcher });
    const res = await app().fetch(new Request("https://x/api/v1/me/profile", { headers: { authorization: "Bearer t" } }), env, execCtx);
    expect(res.status).toBe(200);
    expect((await res.json()) as gateway.MeProfileResponse).toEqual({ displayName: "Alice", avatarUrl: "data:image/png;base64,AAAA" });
  });

  it("POST forwards the patch to identity's internal self-profile route (x-dub-internal) and returns the persisted slice", async () => {
    const identity = fakeBinding((req) => {
      const path = new URL(req.url).pathname;
      if (path === "/internal/users/usr_1/profile") return json(200, { ...IDENTITY_USER, displayName: "Bob", avatarUrl: null });
      return json(404, { error: { code: "NOT_FOUND", message: "no", retryable: false } });
    });
    const env = makeEnv({ SVC_AUTH: auth(), SVC_IDENTITY: identity.fetcher });
    const res = await app().fetch(
      new Request("https://x/api/v1/me/profile", {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Bob", avatarUrl: null }),
      }),
      env,
      execCtx,
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as gateway.MeProfileResponse).toEqual({ displayName: "Bob", avatarUrl: null });
    const fwd = identity.requests.find((r) => new URL(r.url).pathname === "/internal/users/usr_1/profile");
    expect(fwd?.method).toBe("POST");
    expect(fwd?.headers.get(HDR_INTERNAL)).toBe("1");
  });

  it("requires auth", async () => {
    const env = makeEnv({ SVC_AUTH: authBinding({ valid: false, userId: null, session: null, reason: "malformed" }).fetcher });
    const res = await app().fetch(new Request("https://x/api/v1/me/profile", { headers: { authorization: "Bearer bad" } }), env, execCtx);
    expect(res.status).toBe(401);
  });
});

describe("GET/POST /api/v1/me/participation", () => {
  it("GET forwards to member-service's internal self route and passes the 参加届 through", async () => {
    const memberSvc = fakeBinding((req) =>
      new URL(req.url).pathname === "/members/internal/me/participation"
        ? json(200, SELF_PART)
        : json(404, { error: { code: "NOT_FOUND", message: "no", retryable: false } }),
    );
    const env = makeEnv({ SVC_AUTH: auth(), SVC_MEMBER: memberSvc.fetcher });
    const res = await app().fetch(new Request("https://x/api/v1/me/participation", { headers: { authorization: "Bearer t" } }), env, execCtx);
    expect(res.status).toBe(200);
    expect((await res.json()) as member.SelfParticipation).toEqual(SELF_PART);
    const fwd = memberSvc.requests.find((r) => new URL(r.url).pathname === "/members/internal/me/participation");
    expect(fwd?.headers.get(HDR_INTERNAL)).toBe("1");
  });

  it("POST forwards the patch and returns the persisted 参加届", async () => {
    const memberSvc = fakeBinding((req) =>
      new URL(req.url).pathname === "/members/internal/me/participation"
        ? json(200, { ...SELF_PART, phone: "080-0000-1111" })
        : json(404, { error: { code: "NOT_FOUND", message: "no", retryable: false } }),
    );
    const env = makeEnv({ SVC_AUTH: auth(), SVC_MEMBER: memberSvc.fetcher });
    const res = await app().fetch(
      new Request("https://x/api/v1/me/participation", {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({ phone: "080-0000-1111" }),
      }),
      env,
      execCtx,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as member.SelfParticipation).phone).toBe("080-0000-1111");
  });
});
