// Credential forwarding (GatewayRoute.forwardCredentials).
//
// Regression suite for the "logged out after ~1 hour" bug: sanitizeHeaders stripped
// `cookie` unconditionally, so POST /api/v1/auth/refresh reached auth-service with no
// token at all (the SPA sends an empty body and no bearer) -> 401 -> the SPA bounced to
// /login every hour. POST /api/v1/auth/logout broke the same way, silently leaving the
// session live in KV. The auth segment now opts into forwarding; everything else must
// keep the "token stays at the edge" guarantee.
import { describe, it, expect } from "vitest";
import { HDR_USER_ID, HDR_CALLER, HDR_INTERNAL } from "@dub/observability";
import { createApp } from "../src/app";
import { ROUTES } from "../src/routes";
import { fakeBinding, authBinding, validSession, json, makeEnv, execCtx, errOf } from "./helpers";

const NO_RL = {
  rateLimiter: {
    check: async () => ({ allowed: true, limit: 1e9, remaining: 1e9, retryAfterSec: 0, resetEpochSec: 0 }),
  },
};
const app = () => createApp(NO_RL);

const SESSION_COOKIE = "dub_session=sess_abcdefghijklmnopqrstuvwxyz; theme=dark";

/** SVC_AUTH stub that echoes back exactly what the proxy handed it. */
function echoAuth() {
  return fakeBinding((req) =>
    json(200, {
      path: new URL(req.url).pathname,
      host: new URL(req.url).host,
      cookie: req.headers.get("cookie"),
      authorization: req.headers.get("authorization"),
      user: req.headers.get(HDR_USER_ID),
      caller: req.headers.get(HDR_CALLER),
      internal: req.headers.get(HDR_INTERNAL),
    }),
  );
}

describe("credential forwarding: auth segment", () => {
  it("POST /auth/refresh receives the session cookie downstream (the hourly-logout bug)", async () => {
    const auth = echoAuth();
    const res = await app().fetch(
      new Request("https://api.developershub.jp/api/v1/auth/refresh", {
        method: "POST",
        headers: { cookie: SESSION_COOKIE, "content-type": "application/json" },
        body: "{}",
      }),
      makeEnv({ SVC_AUTH: auth.fetcher }),
      execCtx,
    );
    expect(res.status).toBe(200);

    // The assertion that was missing: the cookie ACTUALLY ARRIVED at auth-service.
    const fwd = auth.requests[0]!;
    expect(fwd.headers.get("cookie")).toBe(SESSION_COOKIE);
    expect(new URL(fwd.url).pathname).toBe("/auth/refresh");
    expect(await fwd.text()).toBe("{}");
    expect((await res.json() as { cookie: string }).cookie).toBe(SESSION_COOKIE);
  });

  it("POST /auth/logout receives the session cookie, so the session can be revoked server-side", async () => {
    const auth = echoAuth();
    await app().fetch(
      new Request("https://x/api/v1/auth/logout", {
        method: "POST",
        headers: { cookie: SESSION_COOKIE, "content-type": "application/json" },
        body: "{}",
      }),
      makeEnv({ SVC_AUTH: auth.fetcher }),
      execCtx,
    );
    expect(auth.requests[0]!.headers.get("cookie")).toBe(SESSION_COOKIE);
  });

  it("the mobile bearer path is forwarded too", async () => {
    const auth = echoAuth();
    await app().fetch(
      new Request("https://x/api/v1/auth/refresh", {
        method: "POST",
        headers: { authorization: "Bearer mobile_token_123", "content-type": "application/json" },
        body: "{}",
      }),
      makeEnv({ SVC_AUTH: auth.fetcher }),
      execCtx,
    );
    expect(auth.requests[0]!.headers.get("authorization")).toBe("Bearer mobile_token_123");
  });

  it("still strips x-dub-* / never sets x-dub-internal / never forwards the original host", async () => {
    const auth = echoAuth();
    const res = await app().fetch(
      new Request("https://api.developershub.jp/api/v1/auth/refresh", {
        method: "POST",
        headers: {
          cookie: SESSION_COOKIE,
          "content-type": "application/json",
          [HDR_USER_ID]: "usr_SPOOFED",
          [HDR_INTERNAL]: "1",
          [HDR_CALLER]: "evil",
        },
        body: "{}",
      }),
      makeEnv({ SVC_AUTH: auth.fetcher }),
      execCtx,
    );
    const b = (await res.json()) as Record<string, string | null>;
    expect(b.cookie).toBe(SESSION_COOKIE); // credential forwarded...
    expect(b.internal).toBeNull(); // ...but the internal marker is NOT (auth-service's
    expect(b.user).toBeNull(); //      requireInternal routes stay unreachable; auth is
    expect(b.caller).toBe("api-gateway"); //  a public route so no verified user id exists
    expect(b.host).toBe("svc"); // re-targeted at the binding, not the public origin
  });

  it("auth-service's internal-only routes are unreachable from outside", async () => {
    const auth = echoAuth();
    const env = makeEnv({ SVC_AUTH: auth.fetcher });
    const a = app();
    // The gateway only ever forwards paths whose first segment matched a rule, so the
    // forwarded path always starts with /auth/. /verify, /internal/* and /mobile/exchange
    // have no top-level rule at all -> 404 before any binding is touched.
    for (const p of ["/api/v1/verify", "/api/v1/internal/revoke-user", "/api/v1/mobile/exchange"]) {
      const res = await a.fetch(new Request(`https://x${p}`, { method: "POST", headers: { cookie: SESSION_COOKIE }, body: "{}" }), env, execCtx);
      expect(res.status).toBe(404);
      expect((await errOf(res)).code).toBe("GATEWAY_ROUTE_NOT_FOUND");
    }
    expect(auth.requests).toHaveLength(0);
  });
});

describe("credential forwarding: every other segment keeps the token at the edge", () => {
  it("a non-auth segment never sees cookie or authorization", async () => {
    const task = fakeBinding((req) =>
      json(200, { cookie: req.headers.get("cookie"), authorization: req.headers.get("authorization") }),
    );
    const env = makeEnv({ SVC_AUTH: authBinding(validSession("usr_real")).fetcher, SVC_TASK: task.fetcher });

    const res = await app().fetch(
      new Request("https://x/api/v1/tasks", {
        headers: { cookie: SESSION_COOKIE, authorization: "Bearer leaky" },
      }),
      env,
      execCtx,
    );
    expect(res.status).toBe(200);
    const fwd = task.requests[0]!;
    expect(fwd.headers.get("cookie")).toBeNull();
    expect(fwd.headers.get("authorization")).toBeNull();
    // The downstream service is told WHO the caller is, never HOW to become them.
    expect(fwd.headers.get(HDR_USER_ID)).toBe("usr_real");
  });

  it("exactly one routing rule opts into credential forwarding, and it is the auth segment", () => {
    const forwarding = ROUTES.filter((r) => r.forwardCredentials);
    expect(forwarding.map((r) => r.segment)).toEqual(["auth"]);
    expect(forwarding[0]!.binding).toBe("SVC_AUTH");
    // No other rule may share the segment (a second "auth" rule would silently inherit).
    expect(ROUTES.filter((r) => r.segment === "auth")).toHaveLength(1);
  });
});
