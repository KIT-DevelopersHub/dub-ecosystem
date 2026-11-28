import { describe, it, expect } from "vitest";
import { lpInsights } from "@dub/types";
import { createApp } from "../src/app";
import { makeEnv, fakeBinding, execCtx } from "./helpers";

const NO_RL = { rateLimiter: { check: async () => ({ allowed: true, limit: 1e9, remaining: 1e9, retryAfterSec: 0, resetEpochSec: 0 }) } };
const LP = "https://hokuriku-it-conf.com";
const IPHONE_IG =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0";

const FIRST: lpInsights.LpInsightBeacon = {
  v: 1,
  path: "/",
  first: true,
  src: "instagram",
  med: "Social",
  cmp: "early bird",
  ref: "https://l.instagram.com/?u=x",
  ms: 12_345,
  scroll: 80,
  sec: ["join", "program", "BAD ID"],
  cta: ["tickets@join", "out:camp-fire.jp@crowdfunding", "javascript:alert(1)@x"],
  steps: ["tickets", "nope"],
  vit: { lcp: 1800, inp: 96, cls: 0.03 },
};

function beacon(body: unknown, headers: Record<string, string> = {}): Request {
  const req = new Request("https://x/api/v1/public/lp-events", {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8", origin: LP, "user-agent": IPHONE_IG, "cf-connecting-ip": "203.0.113.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  Object.defineProperty(req, "cf", { value: { country: "JP", regionCode: "17" } });
  return req;
}

describe("POST /api/v1/public/lp-events", () => {
  it("forwards classified counters only (no ip / ua / id) to lp-analytics", async () => {
    const lp = fakeBinding(() => new Response(null, { status: 204 }));
    const res = await createApp(NO_RL).fetch(beacon(FIRST), makeEnv({ SVC_LP_ANALYTICS: lp.fetcher }), execCtx);
    expect(res.status).toBe(204);
    expect(lp.requests).toHaveLength(1);
    const fwd = lp.requests[0]!;
    expect(new URL(fwd.url).pathname).toBe("/lp/internal/events");
    expect(fwd.headers.get("x-dub-internal")).toBeTruthy();
    const row = (await fwd.json()) as lpInsights.LpInsightIngest;
    expect(row).toEqual({
      path: "/",
      first: true,
      source: "instagram",
      medium: "social",
      campaign: "early-bird",
      referrerHost: "l.instagram.com",
      device: "mobile",
      os: "ios",
      browser: "instagram",
      country: "JP",
      region: "JP-17",
      engagedMs: 12_345,
      scroll: 75,
      sections: ["join", "program"],
      ctas: ["tickets@join", "out:camp-fire.jp@crowdfunding"],
      steps: ["tickets"],
      vitals: { lcp: 1800, inp: 96, cls: 0.03 },
    });
    expect(JSON.stringify(row)).not.toContain("203.0.113.7");
    expect(JSON.stringify(row)).not.toContain("Mozilla");
  });

  it("a non-entry page carries no visit attributes (counted once per visit)", async () => {
    const lp = fakeBinding(() => new Response(null, { status: 204 }));
    await createApp(NO_RL).fetch(beacon({ ...FIRST, first: false, path: "/tickets/" }), makeEnv({ SVC_LP_ANALYTICS: lp.fetcher }), execCtx);
    const row = (await lp.requests[0]!.json()) as lpInsights.LpInsightIngest;
    expect(row).toMatchObject({ path: "/tickets", first: false, source: "instagram", device: null, country: null, region: null, referrerHost: null, vitals: null });
  });

  it("drops DNT / GPC, bots, other origins and malformed bodies with the same 204", async () => {
    const lp = fakeBinding(() => new Response(null, { status: 204 }));
    const env = makeEnv({ SVC_LP_ANALYTICS: lp.fetcher });
    const app = createApp(NO_RL);
    for (const req of [
      beacon(FIRST, { dnt: "1" }),
      beacon(FIRST, { "sec-gpc": "1" }),
      beacon(FIRST, { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" }),
      beacon(FIRST, { origin: "https://evil.example" }),
      beacon("{not json"),
      beacon({ ...FIRST, v: 2 }),
      beacon("x".repeat(lpInsights.LP_INSIGHT_BODY_MAX + 1)),
    ]) {
      expect((await app.fetch(req, env, execCtx)).status).toBe(204);
    }
    expect(lp.requests).toHaveLength(0);
  });

  it("purchaser-only pages (ticket pass / receipt) never reach the counters with their secret path", async () => {
    const lp = fakeBinding(() => new Response(null, { status: 204 }));
    await createApp(NO_RL).fetch(beacon({ ...FIRST, path: "/tickets/pass/tok_secret123" }), makeEnv({ SVC_LP_ANALYTICS: lp.fetcher }), execCtx);
    const row = (await lp.requests[0]!.json()) as lpInsights.LpInsightIngest;
    expect(row.path).toBe("(other)");
  });
});

describe("lpInsights.classifyClient", () => {
  it("returns families only", () => {
    expect(lpInsights.classifyClient("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 Edg/131.0")).toEqual({
      device: "desktop",
      os: "windows",
      browser: "edge",
    });
    expect(lpInsights.classifyClient("Mozilla/5.0 (Linux; Android 14; SM-X200) AppleWebKit/537.36 Chrome/131.0 Safari/537.36")).toMatchObject({
      device: "tablet",
      os: "android",
    });
    expect(lpInsights.classifyClient("Mozilla/5.0 (iPhone) Line/14.0", {})).toMatchObject({ device: "mobile", browser: "line" });
    expect(lpInsights.classifyClient("Mozilla/5.0 (X11; Linux x86_64) Chrome/131", { mobile: "?0", platform: '"Linux"' })).toMatchObject({ device: "desktop", os: "linux" });
    expect(lpInsights.classifyClient("HeadlessChrome/131").device).toBe("bot");
    expect(lpInsights.classifyClient(undefined).device).toBe("bot");
  });
});
