// End-to-end session sliding across the REAL gateway + REAL auth-service (the two
// halves whose contract broke). Reproduces the "logged out after ~1 hour" report:
// the SPA's hourly POST /api/v1/auth/refresh carries the token ONLY in the dub_session
// cookie, the gateway stripped that cookie, auth-service saw an empty token and 401'd,
// and the SPA bounced to /login. Unit tests on either side passed in isolation, so the
// break only shows up when both are wired together.
import { describe, it, expect } from "vitest";
import { createHarness } from "../lib/harness";

/** Pull the dub_session value out of a Set-Cookie response header. */
function sessionCookieValue(setCookie: string | null): string {
  expect(setCookie).toBeTruthy();
  const m = /dub_session=([^;]*)/.exec(setCookie!);
  expect(m).toBeTruthy();
  return m![1]!;
}

describe("session refresh through the gateway (cookie path)", () => {
  it("POST /api/v1/auth/refresh with only a cookie rotates the session and returns 200", async () => {
    const h = await createHarness();
    const token = await h.login("admin");

    const res = await h.gw("POST", "/api/v1/auth/refresh", {
      body: {},
      headers: { cookie: `dub_session=${token}` },
    });

    // Before the fix: 401 AUTH_SESSION_REVOKED (empty token -> "malformed").
    expect(res.status).toBe(200);
    const rotated = sessionCookieValue(res.headers.get("set-cookie"));
    expect(rotated).not.toBe(token);
    expect(res.json<{ session?: unknown; token?: string }>().session).toBeTruthy();
    expect(res.json<{ token?: string }>().token).toBeUndefined(); // cookie path: no body token
  });

  it("the rotated cookie authenticates subsequent API calls", async () => {
    const h = await createHarness();
    const token = await h.login("admin");
    const refreshed = await h.gw("POST", "/api/v1/auth/refresh", {
      body: {},
      headers: { cookie: `dub_session=${token}` },
    });
    const rotated = sessionCookieValue(refreshed.headers.get("set-cookie"));

    const me = await h.gw("GET", "/api/v1/me", { headers: { cookie: `dub_session=${rotated}` } });
    expect(me.status).toBe(200);
  });

  it("a duplicate refresh with the pre-rotation cookie still succeeds (multi-tab burst)", async () => {
    const h = await createHarness();
    const token = await h.login("admin");
    const cookie = `dub_session=${token}`;
    const first = await h.gw("POST", "/api/v1/auth/refresh", { body: {}, headers: { cookie } });
    const second = await h.gw("POST", "/api/v1/auth/refresh", { body: {}, headers: { cookie } });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Both land on the same successor, so no tab ends up holding an orphaned token.
    expect(sessionCookieValue(second.headers.get("set-cookie"))).toBe(
      sessionCookieValue(first.headers.get("set-cookie")),
    );
  });

  it("POST /api/v1/auth/logout with a cookie actually revokes the session server-side", async () => {
    const h = await createHarness();
    const token = await h.login("admin");
    const cookie = `dub_session=${token}`;

    expect((await h.gw("GET", "/api/v1/me", { headers: { cookie } })).status).toBe(200);

    const out = await h.gw("POST", "/api/v1/auth/logout", { body: {}, headers: { cookie } });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");

    // Before the fix the token never reached auth-service, so the session stayed valid
    // in KV for the full 30d absolute TTL even though the browser cookie was cleared.
    const after = await h.gw("GET", "/api/v1/me", { headers: { cookie } });
    expect(after.status).toBe(401);
  });

  it("the bearer (mobile) refresh path keeps working through the gateway", async () => {
    const h = await createHarness();
    const token = await h.login("admin");
    const res = await h.gw("POST", "/api/v1/auth/refresh", { body: {}, token });
    expect(res.status).toBe(200);
    expect(res.json<{ token?: string }>().token).toBeTruthy();
  });
});
