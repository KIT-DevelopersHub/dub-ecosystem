import { describe, it, expect } from "vitest";
import { auth, identity } from "../src/index";

const target = (o: Partial<auth.ImpersonationTarget> = {}): auth.ImpersonationTarget => ({
  id: "usr_m",
  status: "active",
  roleIds: ["role_sys_member"],
  holdsImpersonate: false,
  ...o,
});

describe("auth.impersonationRefusal (shared eligibility rule)", () => {
  it("allows an active, non-privileged member", () => {
    expect(auth.impersonationRefusal({ actorId: "usr_a", target: target() })).toBeNull();
  });
  it("refuses self", () => {
    expect(auth.impersonationRefusal({ actorId: "usr_m", target: target() })).toBe("self");
  });
  it.each(["disabled", "invited", "rejected"])("refuses a %s user", (status) => {
    expect(auth.impersonationRefusal({ actorId: "usr_a", target: target({ status }) })).toBe("inactive");
  });
  it("refuses holders of identity:impersonate and of role_sys_admin (no admin→admin)", () => {
    expect(auth.impersonationRefusal({ actorId: "usr_a", target: target({ holdsImpersonate: true }) })).toBe("privileged");
    expect(auth.impersonationRefusal({ actorId: "usr_a", target: target({ roleIds: [auth.SYS_ADMIN_ROLE_ID] }) })).toBe("privileged");
  });
  it("refuses a nested start first", () => {
    expect(auth.impersonationRefusal({ actorId: "usr_a", actorImpersonating: true, target: target() })).toBe("nested");
  });
  it("every refusal has Japanese copy", () => {
    for (const r of ["self", "inactive", "privileged", "nested"] as const) expect(auth.IMPERSONATION_REFUSAL_LABEL[r]).toMatch(/[ぁ-んァ-ン一-龥]/);
  });
  it("the permission is a dangerous catalog key", () => {
    const entry = identity.PERMISSION_CATALOG.find((e) => e.key === auth.IMPERSONATE_PERMISSION);
    expect(entry?.dangerous).toBe(true);
  });
});

describe("auth.impersonationBlockReason (deny list)", () => {
  it.each([
    ["POST", "/api/v1/me/password", "credential_change"],
    ["POST", "/api/v1/admin/users/u/impersonation", "admin_surface"],
    ["PATCH", "/api/v1/identity/users/u", "identity_change"],
    ["POST", "/api/v1/identity/users/u/roles", "identity_change"],
    ["POST", "/api/v1/members/role-sync/backfill", "role_change"],
    ["POST", "/api/v1/mail/outbox", "mail_send"],
    ["PATCH", "/api/v1/mail/scheduled/s1", "mail_send"],
    ["PUT", "/api/v1/mail/forward", "mail_forwarding"],
  ])("%s %s → %s", (m, p, reason) => {
    expect(auth.impersonationBlockReason(m, p)).toBe(reason);
  });
  it.each([
    ["GET", "/api/v1/mail/messages"],
    ["GET", "/api/v1/identity/users"],
    ["POST", "/api/v1/tasks"],
    ["POST", "/api/v1/me/profile"],
    ["POST", "/api/v1/mail/outboxes"],
    ["DELETE", "/api/v1/mail/scheduled/s1"],
  ])("%s %s is allowed", (m, p) => {
    expect(auth.impersonationBlockReason(m, p)).toBeNull();
  });
});
