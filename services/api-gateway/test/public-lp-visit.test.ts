import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import { classifyDevice } from "../src/handlers/public-lp-visit";
import { makeEnv, fakeBinding, execCtx, errOf } from "./helpers";

const NO_RL = { rateLimiter: { check: async () => ({ allowed: true, limit: 1e9, remaining: 1e9, retryAfterSec: 0, resetEpochSec: 0 }) } };
const LP = "https://hokuriku-it-conf.com";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";

function beacon(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://x/api/v1/public/lp-visits", {
    method: "POST",
    // sendBeacon(Blob) posts text/plain — the CORS-simple form (no preflight).
    headers: { "content-type": "text/plain;charset=UTF-8", origin: LP, "user-agent": IPHONE, "cf-connecting-ip": "203.0.113.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function lpBinding() {
  return fakeBinding(() => new Response(null, { status: 204 }));
}

describe("POST /api/v1/public/lp-visits", () => {
  it("is public and forwards a sanitized row to lp-analytics as s2s", async () => {
    const lp = lpBinding();
    const app = createApp(NO_RL);
    const res = await app.fetch(
      beacon({ source: "instagram", path: "/", lpVersion: "v3.4", referrer: "https://l.instagram.com/x?u=1", vid: "abcDEF123456" }),
      makeEnv({ SVC_LP_ANALYTICS: lp.fetcher }),
      execCtx,
    );
    expect(res.status).toBe(204);
    expect(lp.requests).toHaveLength(1);
    const fwd = lp.requests[0]!;
    expect(new URL(fwd.url).pathname).toBe("/lp/internal/visits");
    expect(fwd.headers.get("x-dub-internal")).toBeTruthy();
    expect(fwd.headers.get("x-dub-user-id")).toBe("system:public-lp-visit");
    const row = (await fwd.json()) as Record<string, unknown>;
    expect(row).toMatchObject({ source: "instagram", path: "/", lpVersion: "v3.4", referrerHost: "l.instagram.com", device: "mobile" });
    // raw ip / ua / vid never leave the edge — only an opaque hash does.
    expect(row.visitorKey).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(row)).not.toContain("203.0.113.7");
    expect(JSON.stringify(row)).not.toContain("abcDEF123456");
  });

  it("same vid → same visitorKey (uniques); different vid → different", async () => {
    const lp = lpBinding();
    const app = createApp(NO_RL);
    const env = makeEnv({ SVC_LP_ANALYTICS: lp.fetcher });
    for (const vid of ["visitorAAAA1", "visitorAAAA1", "visitorBBBB2"]) {
      await app.fetch(beacon({ source: "x", vid }), env, execCtx);
    }
    const keys = await Promise.all(lp.requests.map(async (r) => ((await r.json()) as { visitorKey: string }).visitorKey));
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("drops beacons from a non-LP origin with the same 204 (nothing recorded)", async () => {
    const lp = lpBinding();
    const app = createApp(NO_RL);
    const env = makeEnv({ SVC_LP_ANALYTICS: lp.fetcher });
    expect((await app.fetch(beacon({ source: "x" }, { origin: "https://evil.example" }), env, execCtx)).status).toBe(204);
    const noOrigin = new Request("https://x/api/v1/public/lp-visits", { method: "POST", body: "{}" });
    expect((await app.fetch(noOrigin, env, execCtx)).status).toBe(204);
    expect(lp.requests).toHaveLength(0);
  });

  it("LP_BEACON_ORIGINS overrides the allow-list (staging / preview LPs)", async () => {
    const lp = lpBinding();
    const app = createApp(NO_RL);
    const env = makeEnv({ SVC_LP_ANALYTICS: lp.fetcher, LP_BEACON_ORIGINS: "https://lp-staging.example" });
    await app.fetch(beacon({ source: "x" }, { origin: "https://lp-staging.example" }), env, execCtx);
    await app.fetch(beacon({ source: "x" }), env, execCtx);
    expect(lp.requests).toHaveLength(1);
  });

  it("self-referral is not a referrer; bad JSON is 400", async () => {
    const lp = lpBinding();
    const app = createApp(NO_RL);
    const env = makeEnv({ SVC_LP_ANALYTICS: lp.fetcher });
    await app.fetch(beacon({ referrer: `${LP}/#about` }), env, execCtx);
    expect(((await lp.requests[0]!.json()) as { referrerHost: unknown }).referrerHost).toBeNull();

    const bad = await app.fetch(beacon("not json"), env, execCtx);
    expect(bad.status).toBe(400);
    expect((await errOf(bad)).code).toBe("VALIDATION_FAILED");
  });
});

describe("classifyDevice", () => {
  it("bots / mobile / desktop / unknown", () => {
    expect(classifyDevice("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe("bot");
    expect(classifyDevice("facebookexternalhit/1.1")).toBe("bot");
    expect(classifyDevice(IPHONE)).toBe("mobile");
    expect(classifyDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15")).toBe("desktop");
    expect(classifyDevice(undefined)).toBe("unknown");
  });
});

describe("/api/v1/lp/* routing", () => {
  it("/lp/internal/* is 404 at the edge", async () => {
    const lp = lpBinding();
    const app = createApp(NO_RL);
    const res = await app.fetch(
      new Request("https://x/api/v1/lp/internal/visits", { method: "POST", body: "{}" }),
      makeEnv({ SVC_LP_ANALYTICS: lp.fetcher }),
      execCtx,
    );
    expect(res.status).toBe(404);
    expect(lp.requests).toHaveLength(0);
  });
});
