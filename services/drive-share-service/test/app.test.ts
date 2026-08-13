import { describe, it, expect } from "vitest";
import { CommonErrorCodes } from "@dub/errors";
import { createApp } from "../src/app";
import { createDriveShareService } from "../src/service";
import { createMockDriveShareClient } from "../src/mock-client";
import { DRIVE_WRITE } from "../src/permissions";
import { memAuthz, allowAll, AUTHED, fakeRoster, buildRoleGrants } from "./helpers";

function app(authz = allowAll) {
  const client = createMockDriveShareClient();
  const service = createDriveShareService({ client, config: { listPageSize: 50 } });
  const { service: roleGrants } = buildRoleGrants({
    drive: client,
    roster: fakeRoster({ role_sys_member: ["staff-a@example.com"] }, { role_sys_member: "member" }),
  });
  return createApp({ service, roleGrants, authz });
}

const JSON_HDR = { ...AUTHED, "content-type": "application/json" };

describe("authn", () => {
  it("401 when x-dub-user-id is absent", async () => {
    const res = await app().request("/driveshare/files");
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.code).toBe(CommonErrorCodes.UNAUTHENTICATED);
  });
});

describe("authz", () => {
  it("403 when the permission check denies", async () => {
    const res = await app(memAuthz(() => false)).request("/driveshare/files", { headers: AUTHED });
    expect(res.status).toBe(403);
  });

  it("read-only caller is forbidden from granting", async () => {
    const readOnly = memAuthz((_u, perm) => perm !== DRIVE_WRITE);
    const res = await app(readOnly).request("/driveshare/files/fld_root/permissions", {
      method: "POST",
      headers: JSON_HDR,
      body: JSON.stringify({ emailAddress: "x@example.com", role: "reader" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("reads", () => {
  it("lists files", async () => {
    const res = await app().request("/driveshare/files", { headers: AUTHED });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.files)).toBe(true);
    expect(body.files.length).toBeGreaterThan(0);
  });

  it("lists a file's permissions", async () => {
    const res = await app().request("/driveshare/files/fld_root/permissions", { headers: AUTHED });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.fileId).toBe("fld_root");
    expect(body.permissions.some((p: any) => p.role === "owner")).toBe(true);
  });
});

describe("writes", () => {
  it("grants (201), changes, then revokes a permission", async () => {
    const a = app();
    const grantRes = await a.request("/driveshare/files/fil_budget/permissions", {
      method: "POST",
      headers: JSON_HDR,
      body: JSON.stringify({ emailAddress: "grantee@example.com", role: "reader" }),
    });
    expect(grantRes.status).toBe(201);
    const { permission } = (await grantRes.json()) as any;
    expect(permission.role).toBe("reader");

    const patchRes = await a.request(`/driveshare/files/fil_budget/permissions/${permission.id}`, {
      method: "PATCH",
      headers: JSON_HDR,
      body: JSON.stringify({ role: "writer" }),
    });
    expect(patchRes.status).toBe(200);
    expect(((await patchRes.json()) as any).permission.role).toBe("writer");

    const delRes = await a.request(`/driveshare/files/fil_budget/permissions/${permission.id}`, {
      method: "DELETE",
      headers: AUTHED,
    });
    expect(delRes.status).toBe(200);
    expect(((await delRes.json()) as any).revoked).toBe(true);
  });

  it("400 on an invalid grant email", async () => {
    const res = await app().request("/driveshare/files/fld_root/permissions", {
      method: "POST",
      headers: JSON_HDR,
      body: JSON.stringify({ emailAddress: "bad", role: "reader" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe(CommonErrorCodes.VALIDATION_FAILED);
  });

  it("toggles link sharing on then off", async () => {
    const a = app();
    const on = await a.request("/driveshare/files/fil_budget/link", {
      method: "PUT",
      headers: JSON_HDR,
      body: JSON.stringify({ enabled: true, role: "reader" }),
    });
    expect(on.status).toBe(200);
    expect(((await on.json()) as any).permissions.some((p: any) => p.type === "anyone")).toBe(true);

    const off = await a.request("/driveshare/files/fil_budget/link", {
      method: "PUT",
      headers: JSON_HDR,
      body: JSON.stringify({ enabled: false }),
    });
    expect(((await off.json()) as any).permissions.some((p: any) => p.type === "anyone")).toBe(false);
  });
});

describe("role-grants endpoints", () => {
  it("grants a role (201), lists it, then revokes (204)", async () => {
    const a = app();
    const grantRes = await a.request("/driveshare/files/fil_budget/role-grants", {
      method: "POST",
      headers: JSON_HDR,
      body: JSON.stringify({ roleId: "role_sys_member", driveRole: "reader" }),
    });
    expect(grantRes.status).toBe(201);
    const grant = (await grantRes.json()) as any;
    expect(grant.roleId).toBe("role_sys_member");
    expect(grant.roleName).toBe("member");
    expect(grant.driveRole).toBe("reader");
    expect(grant.memberCount).toBe(1);
    expect(grant.appliedCount).toBe(1);

    const orgList = await a.request("/driveshare/role-grants", { headers: AUTHED });
    expect(((await orgList.json()) as any).items).toHaveLength(1);

    const fileList = await a.request("/driveshare/files/fil_budget/role-grants", { headers: AUTHED });
    expect(((await fileList.json()) as any).items[0].fileId).toBe("fil_budget");

    const del = await a.request("/driveshare/files/fil_budget/role-grants/role_sys_member", {
      method: "DELETE",
      headers: AUTHED,
    });
    expect(del.status).toBe(204);

    const after = await a.request("/driveshare/files/fil_budget/role-grants", { headers: AUTHED });
    expect(((await after.json()) as any).items).toHaveLength(0);
  });

  it("read-only caller cannot grant a role (403)", async () => {
    const readOnly = memAuthz((_u, perm) => perm !== DRIVE_WRITE);
    const res = await app(readOnly).request("/driveshare/files/fil_budget/role-grants", {
      method: "POST",
      headers: JSON_HDR,
      body: JSON.stringify({ roleId: "role_sys_member", driveRole: "reader" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects a non-assignable driveRole (owner) with 400", async () => {
    const res = await app().request("/driveshare/files/fil_budget/role-grants", {
      method: "POST",
      headers: JSON_HDR,
      body: JSON.stringify({ roleId: "role_sys_member", driveRole: "owner" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe(CommonErrorCodes.VALIDATION_FAILED);
  });
});
