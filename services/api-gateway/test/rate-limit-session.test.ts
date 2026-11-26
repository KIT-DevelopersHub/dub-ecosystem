// #856: the limiter keys credentialed requests per SESSION (not per source IP), keeps a
// high per-IP ceiling over them, and falls back to a per-IP bucket for anonymous calls.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createApp } from "../src/app";
import type { GatewayEnv } from "../src/env";
import type { GatewayVariables } from "../src/context";
import {
  createInMemoryRateLimiter,
  DEFAULT_RATE_LIMIT_POLICY,
  rateLimitMiddleware,
  rateLimitPolicyFromEnv,
  sessionKey,
  type RateLimitPolicy,
} from "../src/rate-limit";
import { makeEnv, execCtx, errOf, fakeKv } from "./helpers";

const VENUE_IP = "198.51.100.10";

function memoryLimiter() {
  const clock = 7_000_000;
  return createInMemoryRateLimiter({ windowMs: 60_000, now: () => clock });
}

function appWith(policy?: RateLimitPolicy) {
  return createApp({ rateLimiter: memoryLimiter(), ...(policy ? { rateLimitPolicy: policy } : {}) });
}

function req(opts: { ip?: string; bearer?: string; cookie?: string } = {}): Request {
  const headers: Record<string, string> = { "cf-connecting-ip": opts.ip ?? VENUE_IP };
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.cookie) headers.cookie = `dub_session=${opts.cookie}`;
  return new Request("https://x/healthz", { headers });
}

describe("per-session limiting", () => {
  it("throttles one session without affecting another session on the same IP", async () => {
    const app = appWith({ perSession: 3, perIpAnonymous: 100, perIpCeiling: 1000 });
    const env = makeEnv();
    for (let i = 0; i < 3; i++) expect((await app.fetch(req({ bearer: "tok-alice" }), env, execCtx)).status).toBe(200);

    const blocked = await app.fetch(req({ bearer: "tok-alice" }), env, execCtx);
    expect(blocked.status).toBe(429);
    expect((await errOf(blocked)).code).toBe("RATE_LIMITED");
    expect(blocked.headers.get("ratelimit-limit")).toBe("3");
    expect(blocked.headers.get("retry-after")).toBeTruthy();

    // Bob shares the venue IP but has his own budget.
    const bob = await app.fetch(req({ bearer: "tok-bob" }), env, execCtx);
    expect(bob.status).toBe(200);
    expect(bob.headers.get("ratelimit-limit")).toBe("3");
    expect(bob.headers.get("ratelimit-remaining")).toBe("2");
  });

  it("counts the bearer and the dub_session cookie of the same token as one session", async () => {
    const app = appWith({ perSession: 2, perIpAnonymous: 100, perIpCeiling: 1000 });
    const env = makeEnv();
    expect((await app.fetch(req({ bearer: "tok-same" }), env, execCtx)).status).toBe(200);
    expect((await app.fetch(req({ cookie: "tok-same" }), env, execCtx)).status).toBe(200);
    expect((await app.fetch(req({ cookie: "tok-same" }), env, execCtx)).status).toBe(429);
  });

  it("follows the session across IPs (a member switching networks keeps one budget)", async () => {
    const app = appWith({ perSession: 2, perIpAnonymous: 100, perIpCeiling: 1000 });
    const env = makeEnv();
    expect((await app.fetch(req({ bearer: "tok-roam", ip: "203.0.113.1" }), env, execCtx)).status).toBe(200);
    expect((await app.fetch(req({ bearer: "tok-roam", ip: "203.0.113.2" }), env, execCtx)).status).toBe(200);
    expect((await app.fetch(req({ bearer: "tok-roam", ip: "203.0.113.3" }), env, execCtx)).status).toBe(429);
  });
});

describe("shared venue IP (conference Wi-Fi)", () => {
  it("with the default policy, 30 members x 60 requests from one IP all pass (old limit: 100 total)", async () => {
    // 1800 requests: run them through the limiter middleware alone (same code path and
    // env-default policy createApp mounts) and one member's 60 at a time concurrently.
    // The full createApp stack per request made this time out on loaded CI (#891).
    const app = new Hono<{ Bindings: GatewayEnv; Variables: GatewayVariables }>()
      .use("*", rateLimitMiddleware(memoryLimiter())) // no policy → rateLimitPolicyFromEnv
      .get("/healthz", (c) => c.text("ok"));
    const env = makeEnv();
    const statuses = new Set<number>();
    for (let u = 0; u < 30; u++) {
      const batch = await Promise.all(
        Array.from({ length: 60 }, () => app.fetch(req({ bearer: `member-${u}` }), env, execCtx)),
      );
      for (const res of batch) statuses.add(res.status);
    }
    expect([...statuses]).toEqual([200]);
  });

  it("createApp without a policy override applies the default per-session budget", async () => {
    const res = await appWith().fetch(req({ bearer: "member-0" }), makeEnv(), execCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get("ratelimit-limit")).toBe(String(DEFAULT_RATE_LIMIT_POLICY.perSession));
  });

  it("a heavy member on the shared IP is throttled alone; the others keep working", async () => {
    const app = appWith({ perSession: 50, perIpAnonymous: 10, perIpCeiling: 10_000 });
    const env = makeEnv();
    for (let i = 0; i < 50; i++) await app.fetch(req({ bearer: "heavy" }), env, execCtx);
    expect((await app.fetch(req({ bearer: "heavy" }), env, execCtx)).status).toBe(429);
    for (let u = 0; u < 10; u++) {
      expect((await app.fetch(req({ bearer: `light-${u}` }), env, execCtx)).status).toBe(200);
    }
  });

  it("the per-IP ceiling bounds token spraying from one source", async () => {
    const app = appWith({ perSession: 100, perIpAnonymous: 100, perIpCeiling: 5 });
    const env = makeEnv();
    for (let i = 0; i < 5; i++) {
      expect((await app.fetch(req({ bearer: `random-${i}` }), env, execCtx)).status).toBe(200);
    }
    const blocked = await app.fetch(req({ bearer: "random-new" }), env, execCtx);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("ratelimit-limit")).toBe("5");
    // a different IP is unaffected by that ceiling
    expect((await app.fetch(req({ bearer: "random-new", ip: "203.0.113.99" }), env, execCtx)).status).toBe(200);
  });
});

describe("unauthenticated per-IP limiting", () => {
  it("limits anonymous requests per IP and keeps other IPs and sessions unaffected", async () => {
    const app = appWith({ perSession: 100, perIpAnonymous: 3, perIpCeiling: 1000 });
    const env = makeEnv();
    for (let i = 0; i < 3; i++) expect((await app.fetch(req(), env, execCtx)).status).toBe(200);
    const blocked = await app.fetch(req(), env, execCtx);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("ratelimit-limit")).toBe("3");

    // another IP has its own anonymous bucket
    expect((await app.fetch(req({ ip: "203.0.113.50" }), env, execCtx)).status).toBe(200);
    // a signed-in member on the exhausted IP is counted per session, not blocked
    expect((await app.fetch(req({ bearer: "member" }), env, execCtx)).status).toBe(200);
  });
});

describe("rateLimitPolicyFromEnv", () => {
  it("defaults to 600/session, 300/IP anonymous, 6000/IP ceiling", () => {
    expect(rateLimitPolicyFromEnv(makeEnv())).toEqual(DEFAULT_RATE_LIMIT_POLICY);
    expect(DEFAULT_RATE_LIMIT_POLICY).toEqual({ perSession: 600, perIpAnonymous: 300, perIpCeiling: 6000 });
  });

  it("reads each budget from env, honours the legacy RATE_LIMIT_MAX alias, ignores junk", () => {
    expect(
      rateLimitPolicyFromEnv(makeEnv({ RATE_LIMIT_USER_MAX: "900", RATE_LIMIT_IP_MAX: "50", RATE_LIMIT_IP_CEILING: "9000" })),
    ).toEqual({ perSession: 900, perIpAnonymous: 50, perIpCeiling: 9000 });
    expect(rateLimitPolicyFromEnv(makeEnv({ RATE_LIMIT_MAX: "120" })).perIpAnonymous).toBe(120);
    expect(rateLimitPolicyFromEnv(makeEnv({ RATE_LIMIT_MAX: "120", RATE_LIMIT_IP_MAX: "80" })).perIpAnonymous).toBe(80);
    expect(rateLimitPolicyFromEnv(makeEnv({ RATE_LIMIT_USER_MAX: "abc", RATE_LIMIT_IP_CEILING: "-1" }))).toEqual(
      DEFAULT_RATE_LIMIT_POLICY,
    );
  });

  it("the app applies env budgets when no policy is injected", async () => {
    const app = appWith();
    const env = makeEnv({ RATE_LIMIT_USER_MAX: "2" });
    expect((await app.fetch(req({ bearer: "t" }), env, execCtx)).status).toBe(200);
    expect((await app.fetch(req({ bearer: "t" }), env, execCtx)).status).toBe(200);
    expect((await app.fetch(req({ bearer: "t" }), env, execCtx)).status).toBe(429);
  });
});

describe("session bucket key", () => {
  it("is a stable hash that never contains the raw token", async () => {
    const k1 = await sessionKey("secret-token-value");
    expect(k1).toBe(await sessionKey("secret-token-value"));
    expect(k1).not.toContain("secret");
    expect(k1).toMatch(/^[0-9a-f]{32}$/);
    expect(await sessionKey("other")).not.toBe(k1);
  });

  it("KV-backed limiting stores hashed session keys only", async () => {
    const store = new Map<string, string>();
    const app = createApp();
    const env = makeEnv({ RATE_LIMIT_KV: fakeKv(store).kv, RATE_LIMIT_USER_MAX: "1" });
    expect((await app.fetch(req({ bearer: "raw-session-token" }), env, execCtx)).status).toBe(200);
    expect((await app.fetch(req({ bearer: "raw-session-token" }), env, execCtx)).status).toBe(429);
    for (const key of store.keys()) expect(key).not.toContain("raw-session-token");
  });
});
