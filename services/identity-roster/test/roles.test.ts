import { describe, it, expect } from "vitest";
import type { common, identity } from "@dub/types";
import { makeHarness, asUser, jsonBody } from "./harness";

describe("roles CRUD", () => {
  it("creates a custom role with catalog permissions", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/identity/roles", jsonBody(asUser(h.adminId), "POST", { name: "editor", permissions: ["event:read", "event:write"] }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as identity.Role;
    expect(body.name).toBe("editor");
    expect(body.isSystem).toBe(false);
    expect(body.permissions.sort()).toEqual(["event:read", "event:write"]);
  });

  it("rejects a non-catalog permission key with VALIDATION_FAILED", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/identity/roles", jsonBody(asUser(h.adminId), "POST", { name: "bad", permissions: ["event:read", "not:real"] }));
    expect(res.status).toBe(400);
  });

  it("rejects a duplicate role name with CONFLICT", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/identity/roles", jsonBody(asUser(h.adminId), "POST", { name: "member", permissions: ["identity:read"] }));
    expect(res.status).toBe(409);
  });

  it("updates a role's permission bundle", async () => {
    const h = await makeHarness();
    const created = (await (await h.app.request("/identity/roles", jsonBody(asUser(h.adminId), "POST", { name: "tmp", permissions: ["task:read"] }))).json()) as identity.Role;
    const res = await h.app.request(`/identity/roles/${created.id}`, jsonBody(asUser(h.adminId), "PATCH", { permissions: ["task:read", "task:write"] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as identity.Role;
    expect(body.permissions.sort()).toEqual(["task:read", "task:write"]);
  });

  it("lets an admin edit a system role's permission bundle", async () => {
    const h = await makeHarness();
    // member is a system role; add mail:read to it via PATCH.
    const res = await h.app.request(`/identity/roles/${h.memberRoleId}`, jsonBody(asUser(h.adminId), "PATCH", { permissions: ["identity:read", "event:read", "task:read", "task:write", "file:read", "file:write", "chat:create", "mail:read"] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as identity.Role;
    expect(body.permissions).toContain("mail:read");
    expect(body.isSystem).toBe(true);
  });

  it("refuses to strip identity:admin from the admin role (self-lockout guard)", async () => {
    const h = await makeHarness();
    const res = await h.app.request(`/identity/roles/${h.adminRoleId}`, jsonBody(asUser(h.adminId), "PATCH", { permissions: ["identity:read", "event:read"] }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; details?: { code?: string } } };
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.details?.code).toBe("LAST_ADMIN");
  });

  it("lets the admin role edit other permissions while keeping identity:admin", async () => {
    const h = await makeHarness();
    const res = await h.app.request(`/identity/roles/${h.adminRoleId}`, jsonBody(asUser(h.adminId), "PATCH", { permissions: ["identity:read", "identity:admin", "event:read"] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as identity.Role;
    expect(body.permissions).toContain("identity:admin");
    expect(body.permissions).not.toContain("event:write");
  });

  it("refuses to delete a system role with CONFLICT", async () => {
    const h = await makeHarness();
    const res = await h.app.request(`/identity/roles/${h.adminRoleId}`, { ...asUser(h.adminId), method: "DELETE" });
    expect(res.status).toBe(409);
  });

  it("deletes a custom role (204)", async () => {
    const h = await makeHarness();
    const created = (await (await h.app.request("/identity/roles", jsonBody(asUser(h.adminId), "POST", { name: "throwaway", permissions: ["task:read"] }))).json()) as identity.Role;
    const res = await h.app.request(`/identity/roles/${created.id}`, { ...asUser(h.adminId), method: "DELETE" });
    expect(res.status).toBe(204);
  });

  it("lists roles including the system roles (admin/maintainer/organizer/member)", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/identity/roles", asUser(h.adminId));
    const body = (await res.json()) as common.Paginated<identity.Role>;
    const names = body.items.map((r) => r.name).sort();
    expect(names).toEqual(["admin", "maintainer", "member", "organizer"]);
  });

  // ── policy layer: the per-app 3 段階 is authoritative for WRITES ────────────────
  // ロール管理 can set the 管理 app to 無効/閲覧/編集 per role. 閲覧 must mean "cannot change
  // anything" on the SERVER too — not just a greyed button — otherwise a curl bypasses it.
  async function userWithRole(h: Awaited<ReturnType<typeof makeHarness>>, name: string, permissions: identity.PermissionKey[]) {
    const role = { id: `role_${name}`, orgId: h.deps.defaultOrgId, name, isSystem: false, permissions, createdAt: h.deps.now(), updatedAt: h.deps.now() };
    await h.repo.createRole(role);
    const userId = `user_${name}`;
    await h.repo.createUser({
      id: userId, orgId: h.deps.defaultOrgId, email: `${name}@devhub.jp`, displayName: name, furigana: null,
      githubLogin: null, avatarUrl: null, status: "active", source: "manual", createdAt: h.deps.now(), updatedAt: h.deps.now(),
    });
    await h.repo.createAssignment({ id: `ra_${name}`, userId, roleId: role.id, orgId: h.deps.defaultOrgId, resourceType: null, resourceId: null, grantedBy: h.adminId, grantedAt: h.deps.now() });
    return userId;
  }

  it("403s a role holding identity:admin but only 閲覧 on the 管理 app (read_only)", async () => {
    const h = await makeHarness();
    const viewer = await userWithRole(h, "adminviewer", ["identity:admin", "identity:read", "app:admin:view"]);
    const res = await h.app.request("/identity/roles", jsonBody(asUser(viewer), "POST", { name: "nope", permissions: ["task:read"] }));
    expect(res.status).toBe(403);
    // reads stay allowed: 閲覧 means see-but-not-change, and identity:read is shared surface.
    expect((await h.app.request("/identity/roles", asUser(viewer))).status).toBe(200);
  });

  it("403s a role holding identity:admin while the 管理 app is 無効 (app_disabled)", async () => {
    const h = await makeHarness();
    const off = await userWithRole(h, "adminoff", ["identity:admin", "identity:read"]);
    const res = await h.app.request("/identity/roles", jsonBody(asUser(off), "POST", { name: "nope2", permissions: ["task:read"] }));
    expect(res.status).toBe(403);
  });

  it("allows writes for a role at 編集 on the 管理 app", async () => {
    const h = await makeHarness();
    const editor = await userWithRole(h, "admineditor", ["identity:admin", "identity:read", "app:admin:view", "app:admin:edit"]);
    const res = await h.app.request("/identity/roles", jsonBody(asUser(editor), "POST", { name: "ok", permissions: ["task:read"] }));
    expect(res.status).toBe(201);
  });

  it("normalises app:<id>:edit to also carry app:<id>:view on write (policy invariant)", async () => {
    const h = await makeHarness();
    // A client that POSTs only the edit key must not create an ambiguous role (the shell
    // would grey the app while the service allowed writes).
    const res = await h.app.request("/identity/roles", jsonBody(asUser(h.adminId), "POST", { name: "chatedit", permissions: ["app:chat:edit"] }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as identity.Role;
    expect(body.permissions.sort()).toEqual(["app:chat:edit", "app:chat:view"]);

    // ...and the same on PATCH.
    const patched = await h.app.request(`/identity/roles/${body.id}`, jsonBody(asUser(h.adminId), "PATCH", { permissions: ["app:mail:edit"] }));
    expect(((await patched.json()) as identity.Role).permissions.sort()).toEqual(["app:mail:edit", "app:mail:view"]);
  });

  it("reports member counts per role (admin=1, member=1, organizer=0)", async () => {
    const h = await makeHarness();
    const res = await h.app.request("/identity/roles", asUser(h.adminId));
    const body = (await res.json()) as common.Paginated<identity.Role & { memberCount: number }>;
    const byName = new Map(body.items.map((r) => [r.name, r.memberCount]));
    // harness seeds one admin + one member; organizer role has no holders.
    expect(byName.get("admin")).toBe(1);
    expect(byName.get("member")).toBe(1);
    expect(byName.get("organizer")).toBe(0);
  });
});
