import { describe, it, expect } from "vitest";
import type { identity } from "@dub/types";
import { makeHarness, asUser, jsonBody, ORG_ID } from "./harness";
import type { AssignRoleResult } from "../src/dto";

async function grant(h: Awaited<ReturnType<typeof makeHarness>>, userId: string, roleId: string, extra?: Record<string, unknown>) {
  return h.app.request(`/identity/users/${userId}/roles`, jsonBody(asUser(h.adminId), "POST", { roleId, ...extra }));
}

describe("role assignments", () => {
  it("grants a role and reflects it in the next authz check", async () => {
    const h = await makeHarness();
    // member lacks identity:admin
    let res = await h.app.request("/authz/check", jsonBody({ headers: { "x-dub-internal": "1", "x-dub-request-id": "r" } }, "POST", { subjectUserId: h.memberId, orgId: ORG_ID, checks: [{ permission: "identity:admin" }] }));
    expect(((await res.json()) as identity.AuthzCheckResponse).decisions[0]!.allowed).toBe(false);

    const g = await grant(h, h.memberId, h.adminRoleId);
    expect(g.status).toBe(201);
    const { assignmentId } = (await g.json()) as AssignRoleResult;

    res = await h.app.request("/authz/check", jsonBody({ headers: { "x-dub-internal": "1", "x-dub-request-id": "r" } }, "POST", { subjectUserId: h.memberId, orgId: ORG_ID, checks: [{ permission: "identity:admin" }] }));
    expect(((await res.json()) as identity.AuthzCheckResponse).decisions[0]!.allowed).toBe(true);
    expect(h.audit.syncCalls.some((a) => a.action === "identity.role.assigned")).toBe(true);

    // revoke turns the decision back to deny
    const rv = await h.app.request(`/identity/users/${h.memberId}/roles/${assignmentId}`, { ...asUser(h.adminId), method: "DELETE" });
    expect(rv.status).toBe(204);
    res = await h.app.request("/authz/check", jsonBody({ headers: { "x-dub-internal": "1", "x-dub-request-id": "r" } }, "POST", { subjectUserId: h.memberId, orgId: ORG_ID, checks: [{ permission: "identity:admin" }] }));
    expect(((await res.json()) as identity.AuthzCheckResponse).decisions[0]!.allowed).toBe(false);
    expect(h.audit.syncCalls.some((a) => a.action === "identity.role.revoked")).toBe(true);
  });

  it("rejects a duplicate org-wide grant with CONFLICT", async () => {
    const h = await makeHarness();
    // member already holds member role (from harness); re-grant it
    const res = await grant(h, h.memberId, h.memberRoleId);
    expect(res.status).toBe(409);
  });

  it("supports a resource-scoped grant distinct from an org-wide one", async () => {
    const h = await makeHarness();
    const editor = (await (await h.app.request("/identity/roles", jsonBody(asUser(h.adminId), "POST", { name: "ev-editor", permissions: ["event:write"] }))).json()) as identity.Role;
    const a = await grant(h, h.memberId, editor.id, { resourceType: "event", resourceId: "ev_1" });
    expect(a.status).toBe(201);
    // duplicate of the same scope conflicts
    const dup = await grant(h, h.memberId, editor.id, { resourceType: "event", resourceId: "ev_1" });
    expect(dup.status).toBe(409);
  });

  it("cascade-deletes assignments when the role is deleted", async () => {
    const h = await makeHarness();
    const role = (await (await h.app.request("/identity/roles", jsonBody(asUser(h.adminId), "POST", { name: "temp", permissions: ["task:read"] }))).json()) as identity.Role;
    await grant(h, h.memberId, role.id);
    await h.app.request(`/identity/roles/${role.id}`, { ...asUser(h.adminId), method: "DELETE" });
    const remaining = await h.repo.listAssignmentsByUser(h.memberId, ORG_ID);
    expect(remaining.some((a) => a.roleId === role.id)).toBe(false);
  });

  it("guards against revoking the last identity:admin grant (409)", async () => {
    const h = await makeHarness();
    const assignments = await h.repo.listAssignmentsByUser(h.adminId, ORG_ID);
    const adminAssignment = assignments.find((a) => a.roleId === h.adminRoleId)!;
    const res = await h.app.request(`/identity/users/${h.adminId}/roles/${adminAssignment.id}`, { ...asUser(h.adminId), method: "DELETE" });
    expect(res.status).toBe(409);
  });

  it("fail-close: sync audit failure aborts the grant", async () => {
    const h = await makeHarness();
    h.audit.failSync = true;
    const editor = (await (await h.app.request("/identity/roles", jsonBody(asUser(h.adminId), "POST", { name: "ev2", permissions: ["event:write"] }))).json()) as identity.Role;
    const res = await grant(h, h.memberId, editor.id);
    expect(res.status).toBe(502);
    const remaining = await h.repo.listAssignmentsByUser(h.memberId, ORG_ID);
    expect(remaining.some((a) => a.roleId === editor.id)).toBe(false);
  });
});
