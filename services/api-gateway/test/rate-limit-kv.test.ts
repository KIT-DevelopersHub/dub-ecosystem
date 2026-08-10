import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { createKvRateLimiter, rateLimiterFromEnv } from "../src/rate-limit";
import { makeEnv, execCtx, errOf, fakeKv } from "./helpers";

const IP = { "cf-connecting-ip": "203.0.113.7" };

describe("createKvRateLimiter (shared fixed window)", () => {
  it("allows up to the limit, blocks beyond, and emits the wire signals", async () => {
    let clock = 5_000_000;
    const { kv } = fakeKv();
    const limiter = createKvRateLimiter(kv, { limit: 2, windowMs: 1000, now: () => clock });

    const a = await limiter.check("k");
    expect(a).toMatchObject({ allowed: true, limit: 2, remaining: 1 });
    const b = await limiter.check("k");
    expect(b).toMatchObject({ allowed: true, remaining: 0 });
    const c = await limiter.check("k");
    expect(c.allowed).toBe(false);
    expect(c.remaining).toBe(0);
    expect(c.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(c.resetEpochSec).toBeGreaterThan(Math.floor(clock / 1000));
  });

  it("recovers in the next window and isolates distinct keys", async () => {
    let clock = 5_000_000;
    const { kv } = fakeKv();
    const limiter = createKvRateLimiter(kv, { limit: 1, windowMs: 1000, now: () => clock });

    expect((await limiter.check("a")).allowed).toBe(true);
    expect((await limiter.check("a")).allowed).toBe(false);
    // a different client key has its own bucket
    expect((await limiter.check("b")).allowed).toBe(true);
    // advance past the window boundary — the counter resets
    clock += 1000;
    expect((await limiter.check("a")).allowed).toBe(true);
  });

  it("counter is shared across limiter instances over the same store (cross-isolate)", async () => {
    const clock = 5_000_000;
    const store = new Map<string, string>();
    const mk = () => createKvRateLimiter(fakeKv(store).kv, { limit: 2, windowMs: 1000, now: () => clock });

    // two independent limiter objects (two isolates) sharing one KV store
    expect((await mk().check("k")).allowed).toBe(true);
    expect((await mk().check("k")).allowed).toBe(true);
    expect((await mk().check("k")).allowed).toBe(false); // 3rd hit blocked fleet-wide
  });
});

describe("rateLimiterFromEnv", () => {
  it("returns undefined when no KV namespace is bound", () => {
    expect(rateLimiterFromEnv(makeEnv())).toBeUndefined();
  });

  it("builds a KV limiter when RATE_LIMIT_KV is bound", async () => {
    const { kv } = fakeKv();
    const limiter = rateLimiterFromEnv(makeEnv({ RATE_LIMIT_KV: kv }));
    expect(limiter).toBeDefined();
    // default policy = 100 rpm
    expect((await limiter!.check("k")).limit).toBe(100);
  });

  it("honours the RATE_LIMIT_MAX override var", async () => {
    const { kv } = fakeKv();
    const limiter = rateLimiterFromEnv(makeEnv({ RATE_LIMIT_KV: kv, RATE_LIMIT_MAX: "5" }));
    expect((await limiter!.check("k")).limit).toBe(5);
  });
});

describe("gateway uses the shared KV limiter when bound", () => {
  it("enforces the limit across two separate app instances (isolates)", async () => {
    const store = new Map<string, string>();
    const env = makeEnv({ RATE_LIMIT_KV: fakeKv(store).kv, RATE_LIMIT_MAX: "2" });

    // No injected limiter -> preferEnv path picks up RATE_LIMIT_KV.
    const appA = createApp();
    const appB = createApp();
    const hit = (app: ReturnType<typeof createApp>) =>
      app.fetch(new Request("https://x/healthz", { headers: IP }), env, execCtx);

    expect((await hit(appA)).status).toBe(200);
    expect((await hit(appA)).status).toBe(200);
    // a fresh isolate (appB) still sees the shared counter -> blocked
    const blocked = await hit(appB);
    expect(blocked.status).toBe(429);
    expect((await errOf(blocked)).code).toBe("RATE_LIMITED");
    expect(blocked.headers.get("ratelimit-limit")).toBe("2");
    expect(blocked.headers.get("ratelimit-remaining")).toBe("0");
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });

  it("falls back to in-memory (per-isolate) when no KV is bound", async () => {
    const env = makeEnv(); // no RATE_LIMIT_KV
    const appA = createApp();
    const appB = createApp();
    const hit = (app: ReturnType<typeof createApp>) =>
      app.fetch(new Request("https://x/healthz", { headers: IP }), env, execCtx);

    // in-memory default limit is 100; a couple of hits on each isolate all pass
    expect((await hit(appA)).status).toBe(200);
    expect((await hit(appB)).status).toBe(200);
  });
});
