import { describe, it, expect } from "vitest";
import { HDR_REQUEST_ID } from "@dub/observability";
import { isErrorResponse } from "@dub/errors";
import { createApp } from "../src/app";
import { createInMemoryRateLimiter } from "../src/rate-limit";
import { makeEnv, execCtx, errOf, jsonOf } from "./helpers";
import type { HealthzResponse } from "../src/handlers/healthz";

const NO_RL = { rateLimiter: { check: async () => ({ allowed: true, limit: 1e9, remaining: 1e9, retryAfterSec: 0, resetEpochSec: 0 }) } };

describe("healthz", () => {
  it("public liveness with version + requestId", async () => {
    const app = createApp(NO_RL);
    const res = await app.fetch(new Request("https://x/healthz"), makeEnv(), execCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthzResponse;
    expect(body.status).toBe("ok");
    expect(body.version).toBe("test-1");
    expect(body.requestId).toBe(res.headers.get(HDR_REQUEST_ID));
  });
});

describe("prefix mount alignment (spec <-> impl drift lock)", () => {
  // These pin the exact boundary the OpenAPI spec declares: /healthz is root-mounted
  // (outside API_PREFIX); every gateway-owned route lives under API_PREFIX. If the mount
  // prefix in app.ts ever drifts from routes.ts / the spec, one of these flips to 404.
  it("/healthz is served at the root, NOT under the API prefix", async () => {
    const app = createApp(NO_RL);
    const root = await app.fetch(new Request("https://x/healthz"), makeEnv(), execCtx);
    expect(root.status).toBe(200);

    const prefixed = await app.fetch(new Request("https://x/api/v1/healthz"), makeEnv(), execCtx);
    expect(prefixed.status).toBe(404);
    expect((await errOf(prefixed)).code).toBe("GATEWAY_ROUTE_NOT_FOUND");
  });

  it("gateway-owned routes are only reachable under the API prefix", async () => {
    const app = createApp(NO_RL);
    // /me without the prefix must not resolve (it is mounted at API_PREFIX/me).
    const bare = await app.fetch(new Request("https://x/me"), makeEnv(), execCtx);
    expect(bare.status).toBe(404);
    expect((await errOf(bare)).code).toBe("GATEWAY_ROUTE_NOT_FOUND");
  });
});

describe("[case8] rate limiting", () => {
  it("allows up to the limit, 429s beyond it with RateLimit-*/Retry-After, recovers after window", async () => {
    let clock = 1_000_000;
    const limiter = createInMemoryRateLimiter({ limit: 2, windowMs: 1000, now: () => clock });
    const app = createApp({ rateLimiter: limiter });
    const env = makeEnv();
    const hit = () => app.fetch(new Request("https://x/healthz"), env, execCtx);

    expect((await hit()).status).toBe(200);
    const second = await hit();
    expect(second.status).toBe(200);
    expect(second.headers.get("ratelimit-limit")).toBe("2");
    expect(second.headers.get("ratelimit-remaining")).toBe("0");

    const blocked = await hit();
    expect(blocked.status).toBe(429);
    expect((await errOf(blocked)).code).toBe("RATE_LIMITED");
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    expect(blocked.headers.get("ratelimit-limit")).toBe("2");

    clock += 1000; // next window
    expect((await hit()).status).toBe(200);
  });
});

describe("[case12] CORS", () => {
  it("preflight from an allowed origin returns credentialed CORS headers", async () => {
    const app = createApp(NO_RL);
    const res = await app.fetch(
      new Request("https://x/api/v1/tasks", { method: "OPTIONS", headers: { origin: "https://app.developershub.jp" } }),
      makeEnv(),
      execCtx,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.developershub.jp");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    // PUT must be allowed — the SPA saves gantt deps / view state / drive links with it.
    expect(res.headers.get("access-control-allow-methods")).toContain("PUT");
  });

  it("actual response echoes ACAO for allowed origin, omits it for a disallowed one", async () => {
    const app = createApp(NO_RL);
    const allowed = await app.fetch(new Request("https://x/healthz", { headers: { origin: "https://app.developershub.jp" } }), makeEnv(), execCtx);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.developershub.jp");

    const denied = await app.fetch(new Request("https://x/healthz", { headers: { origin: "https://evil.example.com" } }), makeEnv(), execCtx);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("[case15] error wire format", () => {
  it("errors conform to @dub/errors ErrorResponse and carry requestId", async () => {
    const app = createApp(NO_RL);
    const res = await app.fetch(new Request("https://x/api/v1/nope"), makeEnv(), execCtx);
    expect(res.status).toBe(404);
    const raw = await jsonOf<unknown>(res.clone());
    expect(isErrorResponse(raw)).toBe(true);
    const err = await errOf(res);
    expect(err.code).toBe("GATEWAY_ROUTE_NOT_FOUND");
    expect(typeof err.retryable).toBe("boolean");
    expect(err.requestId).toBe(res.headers.get(HDR_REQUEST_ID));
  });
});
