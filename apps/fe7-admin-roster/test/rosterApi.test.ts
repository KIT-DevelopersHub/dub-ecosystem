import { describe, it, expect } from "vitest";
import { isErrorResponse } from "@dub/errors";
import { createMockClient } from "../src/api/mockClient";
import { createRosterApi } from "../src/api/rosterApi";
import { DEFAULT_USER_FILTERS } from "../src/lib/listUsersQuery";
import { DEFAULT_AUDIT_FILTERS } from "../src/lib/auditQuery";

function api() {
  return createRosterApi(createMockClient());
}

describe("rosterApi over mock client — contract adherence", () => {
  it("lists seeded users and filters by status", async () => {
    const a = api();
    const all = await a.listUsers(DEFAULT_USER_FILTERS);
    expect(all.items.length).toBeGreaterThanOrEqual(3);
    const invited = await a.listUsers({ ...DEFAULT_USER_FILTERS, status: "invited" });
    expect(invited.items.every((u) => u.status === "invited")).toBe(true);
  });

  it("returns the frozen 23-key permission catalog", async () => {
    const catalog = await api().permissionCatalog();
    expect(catalog).toHaveLength(23);
    expect(catalog.find((e) => e.key === "identity:admin")?.dangerous).toBe(true);
  });

  it("invite: rejects bad email with VALIDATION_FAILED", async () => {
    await expect(api().inviteUser({ email: "not-an-email" })).rejects.toSatisfy((e) =>
      isErrorResponse(e) && e.error.code === "VALIDATION_FAILED",
    );
  });

  it("invite: rejects duplicate email with CONFLICT", async () => {
    await expect(api().inviteUser({ email: "alice@developershub.jp" })).rejects.toSatisfy((e) =>
      isErrorResponse(e) && e.error.code === "CONFLICT",
    );
  });

  it("invite: success creates an invited user", async () => {
    const user = await api().inviteUser({ email: "new@developershub.jp", displayName: "New" });
    expect(user.status).toBe("invited");
    expect(user.email).toBe("new@developershub.jp");
  });

  it("role create -> update -> reflected; system role is protected", async () => {
    const a = api();
    const role = await a.createRole({ name: "lead", permissions: ["event:read"] });
    const updated = await a.updateRole(role.id, { permissions: ["event:read", "event:write"] });
    expect(updated.permissions).toContain("event:write");
    // system role delete rejected
    await expect(a.deleteRole("role_admin")).rejects.toSatisfy((e) => isErrorResponse(e) && e.error.code === "CONFLICT");
  });

  it("assign role then duplicate assign yields CONFLICT", async () => {
    const a = api();
    await a.assignRole("user_carol", { roleId: "role_member" });
    await expect(a.assignRole("user_carol", { roleId: "role_member" })).rejects.toSatisfy((e) =>
      isErrorResponse(e) && e.error.code === "CONFLICT",
    );
  });

  it("patch user status is persisted", async () => {
    const a = api();
    const patched = await a.patchUser("user_bob", { status: "disabled" });
    expect(patched.status).toBe("disabled");
  });

  it("audit logs are scoped to identity.* actions", async () => {
    const page = await api().auditLogs(DEFAULT_AUDIT_FILTERS);
    expect(page.items.every((r) => r.action.startsWith("identity."))).toBe(true);
  });
});
