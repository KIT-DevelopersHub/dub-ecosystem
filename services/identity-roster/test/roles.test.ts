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
