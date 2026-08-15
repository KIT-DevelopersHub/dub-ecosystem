// #2: one-shot退任 (offboard). Verifies the identity-local composite: revoke sessions +
// strip roles + disable, its idempotency, the last-admin guard, and fail-close on the
// session revoker.
import { describe, it, expect } from "vitest";
import type { identity } from "@dub/types";
import { makeHarness, asUser, ORG_ID } from "./harness";
import type { OffboardUserResult } from "../src/dto";

function post(h: Awaited<ReturnType<typeof makeHarness>>, userId: string, caller: string) {
  return h.app.request(`/identity/users/${userId}/offboard`, { ...asUser(caller), method: "POST" });
}

describe("offboard (#2)", () => {
  it("revokes sessions, strips every role, and disables the account in one call", async () => {
    const h = await makeHarness();
    const res = await post(h, h.memberId, h.adminId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OffboardUserResult;

    expect(body.user.status).toBe("disabled");
    expect(body.user.roleIds).toEqual([]);
    expect(body.revokedAssignments).toBe(1);
    expect(body.alreadyDisabled).toBe(false);
    expect(h.revoker.calls).toContain(h.memberId);
    expect(body.steps.map((s) => `${s.step}:${s.status}`)).toEqual([
      "revoke-sessions:done",
      "revoke-roles:done",
      "disable-account:done",
    ]);

    // persisted: the member truly has no assignments left and is disabled.
    const after = await h.repo.listAssignmentsByUser(h.memberId, ORG_ID);
    expect(after).toHaveLength(0);
    expect((await h.repo.getUser(h.memberId))!.status).toBe("disabled");

    // audit published.
    expect(h.audit.published.some((a) => a.action === "identity.user.offboarded")).toBe(true);
  });

  it("is idempotent — a second call is a no-op that still returns 200 with skipped steps", async () => {
    const h = await makeHarness();
    await post(h, h.memberId, h.adminId);
    h.revoker.calls.length = 0;
    const res = await post(h, h.memberId, h.adminId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OffboardUserResult;
    expect(body.alreadyDisabled).toBe(true);
    expect(body.revokedAssignments).toBe(0);
    expect(h.revoker.calls).toHaveLength(0); // no session revoke on an inactive account
    expect(body.steps.every((s) => s.status === "skipped")).toBe(true);
  });

  it("refuses to offboard the last active identity:admin (LAST_ADMIN)", async () => {
    const h = await makeHarness();
    const res = await post(h, h.adminId, h.adminId);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; details?: { code?: string } } };
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.details?.code).toBe("LAST_ADMIN");
    // nothing mutated: admin still active with its role.
    expect((await h.repo.getUser(h.adminId))!.status).toBe("active");
    expect(await h.repo.listAssignmentsByUser(h.adminId, ORG_ID)).toHaveLength(1);
  });

  it("fail-close: if session revoke throws, nothing is mutated", async () => {
    const h = await makeHarness();
    h.revoker.fail = true;
    const res = await post(h, h.memberId, h.adminId);
    expect(res.status).toBeGreaterThanOrEqual(500);
    // account untouched (still active, role intact).
    expect((await h.repo.getUser(h.memberId))!.status).toBe("active");
    expect(await h.repo.listAssignmentsByUser(h.memberId, ORG_ID)).toHaveLength(1);
  });

  it("requires identity:admin and a real user", async () => {
    const h = await makeHarness();
    const forbidden = await post(h, h.memberId, h.memberId); // member lacks identity:admin
    expect(forbidden.status).toBe(403);
    const missing = await post(h, "user_ghost", h.adminId);
    expect(missing.status).toBe(404);
  });

  it("second admin present: offboarding one admin succeeds", async () => {
    const h = await makeHarness();
    // promote member to admin so there are two admins.
    await h.repo.createAssignment({ id: "ra_extra", userId: h.memberId, roleId: h.adminRoleId, orgId: ORG_ID, resourceType: null, resourceId: null, grantedBy: h.adminId, grantedAt: "2026-08-09T00:00:00.000Z" });
    const res = await post(h, h.adminId, h.memberId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OffboardUserResult;
    expect(body.user.status).toBe("disabled");
    // the org still has an active admin (member).
    const admins = await h.repo.usersWithOrgWidePermission(ORG_ID, "identity:admin" as identity.PermissionKey);
    expect(admins).toEqual([h.memberId]);
  });
});
