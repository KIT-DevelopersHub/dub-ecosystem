import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { extractToken } from "../src/auth";
import { fakeBinding, authBinding, validSession, json, failingBinding, makeEnv, execCtx, errOf } from "./helpers";

const NO_RL = { rateLimiter: { check: async () => ({ allowed: true, limit: 1e9, remaining: 1e9, retryAfterSec: 0, resetEpochSec: 0 }) } };
const app = () => createApp(NO_RL);

describe("entry authentication", () => {
  it("[case5] token extraction order: Bearer > dub_session cookie > none", () => {
    expect(extractToken(new Headers({ authorization: "Bearer abc" }))).toBe("abc");
    expect(extractToken(new Headers({ cookie: "dub_session=cook; other=1" }))).toBe("cook");
    // Bearer wins when both present
    expect(extractToken(new Headers({ authorization: "Bearer abc", cookie: "dub_session=cook" }))).toBe("abc");
    expect(extractToken(new Headers({}))).toBeNull();
  });

  it("[case5] cookie-only token is accepted and forwarded after verify", async () => {
    const authReqs: Request[] = [];
    const authFetcher = fakeBinding(async (req) => {
      authReqs.push(req.clone());
      return json(200, validSession("usr_cookie"));
    });
    const task = fakeBinding(() => json(200, { ok: true }));
    const env = makeEnv({ SVC_AUTH: authFetcher.fetcher, SVC_TASK: task.fetcher });

    const res = await app().fetch(new Request("https://x/api/v1/tasks", { headers: { cookie: "dub_session=cook123" } }), env, execCtx);
    expect(res.status).toBe(200);
    const verifyBody = (await authReqs[0]!.json()) as { token: string };
    expect(verifyBody.token).toBe("cook123");
  });

  it("[case6] verify success -> 200 passthrough; failure -> 401 UNAUTHENTICATED; downstream not reached on 401", async () => {
    const task = fakeBinding(() => json(200, { ok: true }));

    const okEnv = makeEnv({ SVC_AUTH: authBinding(validSession()).fetcher, SVC_TASK: task.fetcher });
    const ok = await app().fetch(new Request("https://x/api/v1/tasks", { headers: { authorization: "Bearer good" } }), okEnv, execCtx);
    expect(ok.status).toBe(200);

    const badTask = fakeBinding(() => json(200, { ok: true }));
    const badEnv = makeEnv({
      SVC_AUTH: authBinding({ valid: false, userId: null, session: null, reason: "expired" }).fetcher,
      SVC_TASK: badTask.fetcher,
    });
    const bad = await app().fetch(new Request("https://x/api/v1/tasks", { headers: { authorization: "Bearer bad" } }), badEnv, execCtx);
    expect(bad.status).toBe(401);
    expect((await errOf(bad)).code).toBe("UNAUTHENTICATED");
    expect(badTask.requests.length).toBe(0);
  });

  it("[case6] missing token -> 401 without hitting auth-service", async () => {
    const env = makeEnv({ SVC_AUTH: authBinding(validSession()).fetcher });
    const res = await app().fetch(new Request("https://x/api/v1/tasks"), env, execCtx);
    expect(res.status).toBe(401);
    expect((await errOf(res)).code).toBe("UNAUTHENTICATED");
  });

  it("[case6] auth-service down -> 502, downstream not reached", async () => {
    const task = fakeBinding(() => json(200, { ok: true }));
    const env = makeEnv({ SVC_AUTH: failingBinding("throw"), SVC_TASK: task.fetcher });
    const res = await app().fetch(new Request("https://x/api/v1/tasks", { headers: { authorization: "Bearer t" } }), env, execCtx);
    expect(res.status).toBe(502);
    expect(task.requests.length).toBe(0);
  });

  it("[case7] /auth/* is public: no token still routes to auth-service", async () => {
    const auth = fakeBinding(() => json(200, { started: true }));
    const env = makeEnv({ SVC_AUTH: auth.fetcher });
    const res = await app().fetch(new Request("https://x/api/v1/auth/login", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), env, execCtx);
    expect(res.status).toBe(200);
    expect(new URL(auth.requests[0]!.url).pathname).toBe("/auth/login");
  });
});
