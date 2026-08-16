import { describe, it, expect } from "vitest";
import type { gateway } from "@dub/types";
import { createApp } from "../src/app";
import { makeEnv, fakeBinding, json, execCtx, errOf, jsonOf } from "./helpers";

const NO_RL = { rateLimiter: { check: async () => ({ allowed: true, limit: 1e9, remaining: 1e9, retryAfterSec: 0, resetEpochSec: 0 }) } };

const validBody = {
  name: "参加 太郎",
  schoolEmail: "taro@school.ac.jp",
  gmail: "taro@gmail.com",
  desiredActivity: "event",
};

function post(body: unknown): Request {
  return new Request("https://x/api/v1/public/participation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** SVC_MEMBER stub answering the internal participation route. */
function memberBinding(matchKind: "created_new" | "linked_existing" = "created_new") {
  return fakeBinding((req) => {
    const path = new URL(req.url).pathname;
    if (path === "/members/internal/participation") {
      return json(201, {
        matchKind,
        participation: { id: "p1", name: "参加 太郎" },
        member: { id: "m1", name: "参加 太郎", schoolEmail: "taro@school.ac.jp", gmail: "taro@gmail.com" },
      });
    }
    return json(404, { error: { code: "NOT_FOUND", message: "no", retryable: false } });
  });
}

describe("POST /api/v1/public/participation", () => {
  it("is public (no auth) — reachable without a token and forwards to member-service", async () => {
    const member = memberBinding("created_new");
    const env = makeEnv({ SVC_MEMBER: member.fetcher });
    const app = createApp({ ...NO_RL, turnstile: async () => true });

    const res = await app.fetch(post(validBody), env, execCtx);
    expect(res.status).toBe(200);
    expect(await jsonOf<gateway.PublicParticipationResponse>(res)).toEqual({ accepted: true, matchKind: "created_new" });

    // forwarded once, to the internal route, as a genuine s2s call (x-dub-internal +
    // system actor), NOT leaking any inbound auth.
    expect(member.requests).toHaveLength(1);
    const fwd = member.requests[0]!;
    expect(new URL(fwd.url).pathname).toBe("/members/internal/participation");
    expect(fwd.headers.get("x-dub-internal")).toBeTruthy();
    expect(fwd.headers.get("x-dub-user-id")).toBe("system:public-participation");
    const forwarded = (await fwd.json()) as Record<string, unknown>;
    expect(forwarded.schoolEmail).toBe("taro@school.ac.jp");
    expect(forwarded.gmail).toBe("taro@gmail.com");
  });

  it("propagates the resolved matchKind without leaking the member identity", async () => {
    const member = memberBinding("linked_existing");
    const env = makeEnv({ SVC_MEMBER: member.fetcher });
    const app = createApp({ ...NO_RL, turnstile: async () => true });
    const res = await app.fetch(post(validBody), env, execCtx);
    const body = await jsonOf<gateway.PublicParticipationResponse & { member?: unknown }>(res);
    expect(body.matchKind).toBe("linked_existing");
    expect(body.member).toBeUndefined();
  });

  it("invalid input -> 400 VALIDATION_FAILED before turnstile / any forward", async () => {
    const member = memberBinding();
    const env = makeEnv({ SVC_MEMBER: member.fetcher });
    let verifierCalled = false;
    const app = createApp({ ...NO_RL, turnstile: async () => { verifierCalled = true; return true; } });

    const res = await app.fetch(post({ name: "", schoolEmail: "bad", gmail: "" }), env, execCtx);
    expect(res.status).toBe(400);
    const err = await errOf(res);
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(Array.isArray(err.details)).toBe(true);
    expect(verifierCalled).toBe(false);
    expect(member.requests).toHaveLength(0);
  });

  it("both emails are required", async () => {
    const member = memberBinding();
    const env = makeEnv({ SVC_MEMBER: member.fetcher });
    const app = createApp({ ...NO_RL, turnstile: async () => true });
    const res = await app.fetch(post({ name: "A", schoolEmail: "s@x.jp" }), env, execCtx);
    expect(res.status).toBe(400);
    expect(member.requests).toHaveLength(0);
  });

  it("turnstile fail -> 403 GATEWAY_TURNSTILE_FAILED, no forward", async () => {
    const member = memberBinding();
    const env = makeEnv({ SVC_MEMBER: member.fetcher });
    const app = createApp({ ...NO_RL, turnstile: async () => false });

    const res = await app.fetch(post(validBody), env, execCtx);
    expect(res.status).toBe(403);
    expect((await errOf(res)).code).toBe("GATEWAY_TURNSTILE_FAILED");
    expect(member.requests).toHaveLength(0);
  });

  it("external /api/v1/members/internal/* is 404 (internal-only, double-defense)", async () => {
    const env = makeEnv();
    const app = createApp({ ...NO_RL });
    const req = new Request("https://x/api/v1/members/internal/participation", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      body: JSON.stringify(validBody),
    });
    const res = await app.fetch(req, env, execCtx);
    expect(res.status).toBe(404);
  });
});
