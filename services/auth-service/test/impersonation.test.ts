// Admin impersonation (代理表示): eligibility, TTL / no-refresh, blocked credential actions,
// audit trail, and stop → the admin's own session restored without a re-login.
import { describe, it, expect } from "vitest";
import { buildApp } from "../src/app";
import { makeHarness, jsonInit, getInit, fakeUser, type TestHarness } from "./helpers";

const ADMIN = "usr_admin01";
const MEMBER = "usr_member1";
const T0 = Date.parse("2026-08-09T12:00:00Z");

function setup(): TestHarness & { adminToken: string } {
  const h = makeHarness();
  h.identity.users.set(ADMIN, fakeUser("admin@developershub.jp", "Admin", { id: ADMIN, roleIds: ["role_sys_admin"] }));
  h.identity.users.set(MEMBER, fakeUser("member@developershub.jp", "Member", { id: MEMBER, roleIds: ["role_sys_member"] }));
  h.identity.impersonators.add(ADMIN);
  return Object.assign(h, { adminToken: "" });
}

async function loginAdmin(h: TestHarness): Promise<string> {
  const created = await h.deps.sessions.create(ADMIN, "web");
  return created.token;
}

/** What the gateway sends: x-dub-internal + the admin as actor + the admin's own token. */
function startInit(adminToken: string, actor = ADMIN): RequestInit {
  return jsonInit({}, { internal: true, actor, bearer: adminToken });
}

function cookieToken(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  const m = /dub_session=([^;]*)/.exec(raw);
  return m ? m[1]! : "";
}

describe("POST /internal/admin/users/:userId/impersonation — start", () => {
  it("issues a subject session that verifies as the member and names the real admin", async () => {
    const h = setup();
    const adminToken = await loginAdmin(h);
    const res = await buildApp(h.deps).request(`/internal/admin/users/${MEMBER}/impersonation`, startInit(adminToken));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { impersonation: { actorId: string; subjectId: string; expiresAt: number }; setCookie: string };
    expect(body.impersonation).toMatchObject({ actorId: ADMIN, subjectId: MEMBER, expiresAt: T0 + 3600_000 });
    expect(body.setCookie).toContain("dub_session=");
    expect(body.setCookie).toContain("HttpOnly");
    expect(body.setCookie).toContain("Max-Age=");

    const token = /dub_session=([^;]*)/.exec(body.setCookie)![1]!;
    const verified = await h.deps.sessions.verify(token);
    expect(verified.valid).toBe(true);
    expect(verified.userId).toBe(MEMBER);
    expect(verified.impersonation).toMatchObject({ actorId: ADMIN, subjectId: MEMBER });
    // the admin's own session is untouched and still valid
    const own = await h.deps.sessions.verify(adminToken);
    expect(own.valid).toBe(true);
    expect(own.impersonation).toBeUndefined();
  });

  it("audits the start with the admin as actor and the member as subject", async () => {
    const h = setup();
    const adminToken = await loginAdmin(h);
    await buildApp(h.deps).request(`/internal/admin/users/${MEMBER}/impersonation`, startInit(adminToken));
    const rec = h.audit.records.find((r) => r.action === "auth.impersonation.started");
    expect(rec).toMatchObject({ actorId: ADMIN, result: "success", resourceType: "user", resourceId: MEMBER });
    expect(rec?.details?.["subjectId"]).toBe(MEMBER);
  });

  it("requires identity:impersonate (identity:admin alone is not enough)", async () => {
    const h = setup();
    h.identity.impersonators.delete(ADMIN);
    h.identity.admins.add(ADMIN);
    const adminToken = await loginAdmin(h);
    const res = await buildApp(h.deps).request(`/internal/admin/users/${MEMBER}/impersonation`, startInit(adminToken));
    expect(res.status).toBe(403);
  });

  it("requires the internal marker (not callable from the open internet)", async () => {
    const h = setup();
    const adminToken = await loginAdmin(h);
    const res = await buildApp(h.deps).request(
      `/internal/admin/users/${MEMBER}/impersonation`,
      jsonInit({}, { actor: ADMIN, bearer: adminToken }),
    );
    expect(res.status).toBe(403);
  });

  const refusals: Array<[string, (h: TestHarness) => void, string]> = [
    ["self", () => {}, ADMIN],
    ["inactive (disabled)", (h) => h.identity.users.set(MEMBER, fakeUser("m@developershub.jp", "M", { id: MEMBER, status: "disabled" })), MEMBER],
    ["inactive (invited)", (h) => h.identity.users.set(MEMBER, fakeUser("m@developershub.jp", "M", { id: MEMBER, status: "invited" })), MEMBER],
    ["privileged (holds identity:impersonate)", (h) => h.identity.impersonators.add(MEMBER), MEMBER],
    ["privileged (role_sys_admin)", (h) => h.identity.users.set(MEMBER, fakeUser("m@developershub.jp", "M", { id: MEMBER, roleIds: ["role_sys_admin"] })), MEMBER],
  ];
  const expectedReason: Record<string, string> = {
    self: "self",
    "inactive (disabled)": "inactive",
    "inactive (invited)": "inactive",
    "privileged (holds identity:impersonate)": "privileged",
    "privileged (role_sys_admin)": "privileged",
  };
  for (const [name, arrange, target] of refusals) {
    it(`refuses ${name} with 403 + reason, audited as denied, no session minted`, async () => {
      const h = setup();
      arrange(h);
      const adminToken = await loginAdmin(h);
      const putsBefore = h.kv.puts.length;
      const res = await buildApp(h.deps).request(`/internal/admin/users/${target}/impersonation`, startInit(adminToken));
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } };
      expect(body.error.code).toBe("AUTH_IMPERSONATION_NOT_ALLOWED");
      expect(body.error.details?.reason).toBe(expectedReason[name]);
      expect(h.kv.puts.length).toBe(putsBefore);
      expect(h.audit.records.some((r) => r.action === "auth.impersonation.started" && r.result === "denied")).toBe(true);
    });
  }

  it("refuses a nested start from inside an impersonation session", async () => {
    const h = setup();
    const OTHER = "usr_other01";
    h.identity.users.set(OTHER, fakeUser("o@developershub.jp", "O", { id: OTHER }));
    const adminToken = await loginAdmin(h);
    const app = buildApp(h.deps);
    const first = await app.request(`/internal/admin/users/${MEMBER}/impersonation`, startInit(adminToken));
    const impToken = /dub_session=([^;]*)/.exec(((await first.json()) as { setCookie: string }).setCookie)![1]!;
    // even if a gateway bug forwarded the admin as actor, the impersonation token is refused
    const res = await app.request(`/internal/admin/users/${OTHER}/impersonation`, startInit(impToken));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe("nested");
  });

  it("404 for an unknown target", async () => {
    const h = setup();
    const adminToken = await loginAdmin(h);
    const res = await buildApp(h.deps).request(`/internal/admin/users/usr_nobody/impersonation`, startInit(adminToken));
    expect(res.status).toBe(404);
  });

  it("rejects a forwarded token that does not belong to the acting admin", async () => {
    const h = setup();
    const memberOwn = (await h.deps.sessions.create(MEMBER, "web")).token;
    const OTHER = "usr_other01";
    h.identity.users.set(OTHER, fakeUser("o@developershub.jp", "O", { id: OTHER }));
    const res = await buildApp(h.deps).request(`/internal/admin/users/${OTHER}/impersonation`, startInit(memberOwn));
    expect(res.status).toBe(401);
  });
});

describe("impersonation TTL — hard, never refreshed", () => {
  async function start(h: TestHarness): Promise<{ adminToken: string; impToken: string }> {
    const adminToken = await loginAdmin(h);
    const res = await buildApp(h.deps).request(`/internal/admin/users/${MEMBER}/impersonation`, startInit(adminToken));
    const impToken = /dub_session=([^;]*)/.exec(((await res.json()) as { setCookie: string }).setCookie)![1]!;
    return { adminToken, impToken };
  }

  it("verifies until the deadline, then is dead", async () => {
    const h = setup();
    const { impToken } = await start(h);
    h.setNow(T0 + 59 * 60_000);
    expect((await h.deps.sessions.verify(impToken)).valid).toBe(true);
    h.setNow(T0 + 60 * 60_000);
    expect((await h.deps.sessions.verify(impToken)).valid).toBe(false);
  });

  it("IMPERSONATION_TTL_SEC overrides the default and is capped at 4h", async () => {
    const short = makeHarness({ IMPERSONATION_TTL_SEC: "600" } as never);
    expect(short.config.impersonationTtlSec).toBe(600);
    const huge = makeHarness({ IMPERSONATION_TTL_SEC: "999999" } as never);
    expect(huge.config.impersonationTtlSec).toBe(4 * 3600);
  });

  it("a refresh ENDS the impersonation and hands back the admin's own session (no extension)", async () => {
    const h = setup();
    const { impToken } = await start(h);
    h.setNow(T0 + 10 * 60_000);
    const res = await buildApp(h.deps).request("/auth/refresh", { method: "POST", headers: { cookie: `dub_session=${impToken}` } });
    expect(res.status).toBe(200);
    const restored = cookieToken(res);
    const v = await h.deps.sessions.verify(restored);
    expect(v.userId).toBe(ADMIN);
    expect(v.impersonation).toBeUndefined();
    expect((await h.deps.sessions.verify(impToken)).valid).toBe(false);
    const stop = h.audit.records.find((r) => r.action === "auth.impersonation.stopped");
    expect(stop).toMatchObject({ actorId: ADMIN, resourceId: MEMBER });
    expect(stop?.details?.["reason"]).toBe("refresh");
  });

  it("a refresh AFTER expiry (backgrounded tab) still restores the admin, audited as expired", async () => {
    const h = setup();
    const { impToken } = await start(h);
    h.setNow(T0 + 2 * 3600_000);
    const res = await buildApp(h.deps).request("/auth/refresh", { method: "POST", headers: { cookie: `dub_session=${impToken}` } });
    expect(res.status).toBe(200);
    expect((await h.deps.sessions.verify(cookieToken(res))).userId).toBe(ADMIN);
    expect(h.audit.records.find((r) => r.action === "auth.impersonation.stopped")?.details?.["reason"]).toBe("expired");
  });

  it("dies with its admin: revoking the actor kills the impersonation too", async () => {
    const h = setup();
    const { impToken } = await start(h);
    await h.deps.sessions.revokeUser(ADMIN);
    expect((await h.deps.sessions.verify(impToken)).valid).toBe(false);
  });
});

describe("blocked credential actions while impersonating", () => {
  async function impToken(h: TestHarness): Promise<string> {
    const adminToken = await loginAdmin(h);
    const res = await buildApp(h.deps).request(`/internal/admin/users/${MEMBER}/impersonation`, startInit(adminToken));
    return /dub_session=([^;]*)/.exec(((await res.json()) as { setCookie: string }).setCookie)![1]!;
  }

  it("self password change → 403 AUTH_IMPERSONATION_ACTION_BLOCKED, audited, password untouched", async () => {
    const h = setup();
    const token = await impToken(h);
    const res = await buildApp(h.deps).request(
      "/auth/password",
      jsonInit({ currentPassword: "x", newPassword: "new-password-1" }, { bearer: token }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("AUTH_IMPERSONATION_ACTION_BLOCKED");
    expect(await h.deps.passwords.get("member@developershub.jp")).toBeNull();
    const rec = h.audit.records.find((r) => r.action === "auth.impersonation.blocked");
    expect(rec).toMatchObject({ actorId: ADMIN, result: "denied", resourceId: MEMBER });
  });

  for (const [method, path] of [
    ["POST", "/auth/passkey/register/options"],
    ["POST", "/auth/passkey/register/verify"],
    ["PATCH", "/auth/passkeys/pk_1"],
    ["DELETE", "/auth/passkeys/pk_1"],
  ] as const) {
    it(`${method} ${path} → 403 (no sign-in method changes as the member)`, async () => {
      const h = setup();
      const token = await impToken(h);
      const res = await buildApp(h.deps).request(path, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: method === "DELETE" ? undefined : JSON.stringify({ password: "x", label: "y", response: {} }),
      });
      expect(res.status).toBe(403);
    });
  }

  it("reading the passkey list is still allowed (what the member sees)", async () => {
    const h = setup();
    const token = await impToken(h);
    const res = await buildApp(h.deps).request("/auth/passkeys", getInit({ bearer: token }));
    expect(res.status).toBe(200);
  });
});

describe("POST /auth/impersonation/stop — return to own account", () => {
  it("restores the admin session via cookie (no re-login) and audits the stop", async () => {
    const h = setup();
    const adminToken = await loginAdmin(h);
    const app = buildApp(h.deps);
    const started = await app.request(`/internal/admin/users/${MEMBER}/impersonation`, startInit(adminToken));
    const impToken = /dub_session=([^;]*)/.exec(((await started.json()) as { setCookie: string }).setCookie)![1]!;

    const res = await app.request("/auth/impersonation/stop", { method: "POST", headers: { cookie: `dub_session=${impToken}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { userId: string } };
    expect(body.session.userId).toBe(ADMIN);
    const restored = cookieToken(res);
    expect(restored).not.toBe(impToken);
    expect((await h.deps.sessions.verify(restored)).userId).toBe(ADMIN);
    expect((await h.deps.sessions.verify(impToken)).valid).toBe(false);
    const rec = h.audit.records.find((r) => r.action === "auth.impersonation.stopped");
    expect(rec).toMatchObject({ actorId: ADMIN, resourceId: MEMBER, result: "success" });
    expect(rec?.details?.["reason"]).toBe("manual");
  });

  it("409 when the session is not an impersonation", async () => {
    const h = setup();
    const adminToken = await loginAdmin(h);
    const res = await buildApp(h.deps).request("/auth/impersonation/stop", { method: "POST", headers: { cookie: `dub_session=${adminToken}` } });
    expect(res.status).toBe(409);
    // and the admin's own session survives
    expect((await h.deps.sessions.verify(adminToken)).valid).toBe(true);
  });

  it("when the admin's own session died meanwhile: 401 + cookie cleared", async () => {
    const h = setup();
    const adminToken = await loginAdmin(h);
    const app = buildApp(h.deps);
    const started = await app.request(`/internal/admin/users/${MEMBER}/impersonation`, startInit(adminToken));
    const impToken = /dub_session=([^;]*)/.exec(((await started.json()) as { setCookie: string }).setCookie)![1]!;
    await h.deps.sessions.logout(adminToken); // e.g. logged out elsewhere
    const res = await app.request("/auth/impersonation/stop", { method: "POST", headers: { cookie: `dub_session=${impToken}` } });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  });

  it("logout from an impersonation signs the admin out too, audited as a stop", async () => {
    const h = setup();
    const adminToken = await loginAdmin(h);
    const app = buildApp(h.deps);
    const started = await app.request(`/internal/admin/users/${MEMBER}/impersonation`, startInit(adminToken));
    const impToken = /dub_session=([^;]*)/.exec(((await started.json()) as { setCookie: string }).setCookie)![1]!;
    const res = await app.request("/auth/logout", { method: "POST", headers: { cookie: `dub_session=${impToken}` } });
    expect(res.status).toBe(200);
    expect((await h.deps.sessions.verify(adminToken)).valid).toBe(false);
    expect(h.audit.records.find((r) => r.action === "auth.impersonation.stopped")?.details?.["reason"]).toBe("logout");
  });
});
