// End-to-end (in-process, REAL apps) for self-owned email+password login through
// the actual api-gateway -> auth-service -> identity-roster chain. Proves the whole
// mechanism: a seeded credential logs in, the gateway verifies the session and
// threads the trusted x-dub-user-id, so a previously-401 authenticated endpoint now
// returns 200 — and the seeded role (admin vs member) is enforced by real authz.
//
// NB: /api/v1/me is intentionally NOT used here — it is a documented pre-existing
// gap (see gaps.test.ts: the gateway meHandler calls identity `/users/:id` at the
// root while identity mounts users under `/identity/*`), unrelated to this change.
// We assert against `/identity/permissions/catalog` (needs identity:read) and the
// admin-only invite route instead, both of which route correctly today.
import { describe, it, expect } from "vitest";
import { createHarness, DEMO_LOGINS } from "../lib/harness";

const CATALOG = "/api/v1/identity/permissions/catalog";
const INVITE = "/api/v1/identity/users/invite"; // requires identity:admin

describe("password login (gateway E2E)", () => {
  it("admin demo account: unauthenticated 401 -> after login 200, and admin-only routes are allowed", async () => {
    const h = await createHarness();

    // baseline: no session -> gateway rejects the authenticated route
    const before = await h.gw("GET", CATALOG);
    expect(before.status).toBe(401);

    // POST /api/v1/auth/password/login with the seeded admin demo credential
    const login = await h.gw("POST", "/api/v1/auth/password/login", {
      body: { email: "admin@developershub.jp", password: DEMO_LOGINS["admin@developershub.jp"] },
    });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie") ?? "").toContain("dub_session=");
    const { token, session } = login.json<{ token: string; session: { client: string } }>();
    expect(token).toBeTruthy();
    expect(session.client).toBe("web");

    // the issued session now authenticates the same route (bearer path via gateway)
    const after = await h.gw("GET", CATALOG, { token });
    expect(after.status).toBe(200);

    // admin role is real: an identity:admin-gated route is NOT forbidden
    const invite = await h.gw("POST", INVITE, { token, body: { email: "new.person@dub.local", displayName: "New" } });
    expect([201, 409]).toContain(invite.status); // created (or already on roster) — crucially not 401/403
  });

  it("member demo account: logs in, can read, but is denied the admin-only route", async () => {
    const h = await createHarness();
    const login = await h.gw("POST", "/api/v1/auth/password/login", {
      body: { email: "member@developershub.jp", password: DEMO_LOGINS["member@developershub.jp"] },
    });
    expect(login.status).toBe(200);
    const { token } = login.json<{ token: string }>();

    // member has identity:read -> catalog is 200
    expect((await h.gw("GET", CATALOG, { token })).status).toBe(200);

    // member lacks identity:admin -> invite is 403 (real authz enforcing the seeded role)
    const invite = await h.gw("POST", INVITE, { token, body: { email: "x@dub.local", displayName: "X" } });
    expect(invite.status).toBe(403);
    expect(invite.json<{ error: { code: string } }>().error.code).toBe("FORBIDDEN");
  });

  it("wrong password is rejected (401 AUTH_INVALID_CREDENTIALS) and issues no session", async () => {
    const h = await createHarness();
    const login = await h.gw("POST", "/api/v1/auth/password/login", {
      body: { email: "admin@developershub.jp", password: "not-the-password" },
    });
    expect(login.status).toBe(401);
    expect(login.json<{ error: { code: string } }>().error.code).toBe("AUTH_INVALID_CREDENTIALS");
    expect(login.headers.get("set-cookie")).toBeNull();
  });
});
