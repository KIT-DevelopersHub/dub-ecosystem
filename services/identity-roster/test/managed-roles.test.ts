// 名簿のチーム・役職から付く自動ロール (PUT /internal/managed-roles, PUT /internal/users/:id/managed-roles).
// Covers: role_auto_* only, idempotent diff, manual grants never touched, admin re-grant pins a
// row as manual, catalog prune (delete vs keep), and the D1 SQL path over node:sqlite.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { createDbClient } from "@dub/db";
import type { identity } from "@dub/types";
import { D1IdentityRepo } from "../src/repo/d1-repo";
import { IdentityService } from "../src/service";
import type { RoleAssignmentView } from "../src/dto";
import { makeOutboxD1 } from "./outbox-d1";
import { FakeAudit, FakeRevoker, makeHarness, asUser, internal, jsonBody, ORG_ID } from "./harness";

type H = Awaited<ReturnType<typeof makeHarness>>;

const TEAM_A = { id: "role_auto_team_team_a", name: "チーム: 広報" };
const TEAM_B = { id: "role_auto_team_team_b", name: "チーム: 開発" };
const LEAD = { id: "role_auto_position_leader", name: "役職: リーダー" };

function putUser(h: H, userId: string, roles: identity.ManagedRoleSpec[], extra: Record<string, unknown> = {}) {
  return h.app.request(
    `/internal/users/${userId}/managed-roles`,
    jsonBody({ headers: { ...internal().headers, "x-dub-user-id": h.adminId } }, "PUT", { roles, ...extra }),
  );
}
function putCatalog(h: H, roles: identity.ManagedRoleSpec[], extra: Record<string, unknown> = {}) {
  return h.app.request("/internal/managed-roles", jsonBody(internal(), "PUT", { roles, ...extra }));
}
async function rolesOf(h: H, userId: string): Promise<RoleAssignmentView[]> {
  const res = await h.app.request(`/identity/users/${userId}/roles`, asUser(h.adminId));
  return (await res.json()) as RoleAssignmentView[];
}

describe("PUT /internal/users/:id/managed-roles", () => {
  it("creates the permission-less roles and grants them org-wide as auto rows", async () => {
    const h = await makeHarness();
    const res = await putUser(h, h.memberId, [TEAM_A, LEAD]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dryRun: false, added: [TEAM_A.id, LEAD.id], removed: [], manual: [] });

    const role = await h.repo.getRole(TEAM_A.id);
    expect(role).toMatchObject({ name: "チーム: 広報", isSystem: false, permissions: [] });
    const mine = await rolesOf(h, h.memberId);
    const auto = mine.filter((a) => a.source === "auto:member-sync");
    expect(auto.map((a) => a.roleId).sort()).toEqual([LEAD.id, TEAM_A.id].sort());
    expect(auto.every((a) => a.resourceType === null && a.grantedBy === h.adminId)).toBe(true);
  });

  it("is idempotent and swaps only the auto rows when the wanted set changes", async () => {
    const h = await makeHarness();
    await putUser(h, h.memberId, [TEAM_A, LEAD]);
    const again = await putUser(h, h.memberId, [TEAM_A, LEAD]);
    expect(await again.json()).toEqual({ dryRun: false, added: [], removed: [], manual: [] });

    const swapped = await putUser(h, h.memberId, [TEAM_B, LEAD]);
    expect(await swapped.json()).toEqual({ dryRun: false, added: [TEAM_B.id], removed: [TEAM_A.id], manual: [] });
    const ids = (await rolesOf(h, h.memberId)).map((a) => a.roleId);
    expect(ids).toContain(h.memberRoleId); // the manual system grant is untouched
    expect(ids).not.toContain(TEAM_A.id);
  });

  it("never removes or duplicates a manual grant of a managed role", async () => {
    const h = await makeHarness();
    await putCatalog(h, [TEAM_A]);
    const g = await h.app.request(`/identity/users/${h.memberId}/roles`, jsonBody(asUser(h.adminId), "POST", { roleId: TEAM_A.id }));
    expect(g.status).toBe(201);

    const res = await putUser(h, h.memberId, [TEAM_A]);
    expect(await res.json()).toEqual({ dryRun: false, added: [], removed: [], manual: [TEAM_A.id] });
    await putUser(h, h.memberId, []); // team left: the manual grant stays
    expect((await rolesOf(h, h.memberId)).some((a) => a.roleId === TEAM_A.id && a.source === "manual")).toBe(true);
  });

  it("an admin re-granting an auto role pins it as manual (survives the next sync)", async () => {
    const h = await makeHarness();
    await putUser(h, h.memberId, [TEAM_A]);
    const g = await h.app.request(`/identity/users/${h.memberId}/roles`, jsonBody(asUser(h.adminId), "POST", { roleId: TEAM_A.id }));
    expect(g.status).toBe(201);
    expect(((await g.json()) as RoleAssignmentView).source).toBe("manual");
    await putUser(h, h.memberId, []);
    expect((await rolesOf(h, h.memberId)).some((a) => a.roleId === TEAM_A.id)).toBe(true);
  });

  it("dryRun reports the diff without writing", async () => {
    const h = await makeHarness();
    const res = await putUser(h, h.memberId, [TEAM_A], { dryRun: true });
    expect(await res.json()).toEqual({ dryRun: true, added: [TEAM_A.id], removed: [], manual: [] });
    expect(await h.repo.getRole(TEAM_A.id)).toBeNull();
    expect((await rolesOf(h, h.memberId)).some((a) => a.roleId === TEAM_A.id)).toBe(false);
  });

  it("rejects non-managed role ids (cannot grant admin/system roles)", async () => {
    const h = await makeHarness();
    const res = await putUser(h, h.memberId, [{ id: h.adminRoleId, name: "admin" }]);
    expect(res.status).toBe(400);
    expect((await rolesOf(h, h.memberId)).some((a) => a.roleId === h.adminRoleId)).toBe(false);
  });

  it("is internal-only and 404s an unknown user", async () => {
    const h = await makeHarness();
    const ext = await h.app.request(`/internal/users/${h.memberId}/managed-roles`, jsonBody(asUser(h.adminId), "PUT", { roles: [] }));
    expect(ext.status).toBe(403);
    expect((await putUser(h, "user_ghost", [TEAM_A])).status).toBe(404);
  });

  it("suffixes the name when an admin-made role already uses it", async () => {
    const h = await makeHarness();
    await h.app.request("/identity/roles", jsonBody(asUser(h.adminId), "POST", { name: "チーム: 広報", permissions: [] }));
    await putUser(h, h.memberId, [TEAM_A]);
    expect((await h.repo.getRole(TEAM_A.id))?.name).toBe("チーム: 広報（自動）");
  });
});

describe("PUT /internal/managed-roles (catalog)", () => {
  it("renames drifted roles (team renamed)", async () => {
    const h = await makeHarness();
    await putCatalog(h, [TEAM_A]);
    const res = await putCatalog(h, [{ id: TEAM_A.id, name: "チーム: 広報部" }]);
    expect(await res.json()).toMatchObject({ created: [], renamed: [TEAM_A.id] });
    expect((await h.repo.getRole(TEAM_A.id))?.name).toBe("チーム: 広報部");
  });

  it("deletes an unlisted managed role held only by auto rows (team deleted)", async () => {
    const h = await makeHarness();
    await putUser(h, h.memberId, [TEAM_A, TEAM_B]);
    const res = await putCatalog(h, [TEAM_B]);
    expect(await res.json()).toMatchObject({ deleted: [TEAM_A.id], kept: [] });
    expect(await h.repo.getRole(TEAM_A.id)).toBeNull();
    expect((await rolesOf(h, h.memberId)).map((a) => a.roleId)).toContain(TEAM_B.id);
  });

  it("keeps an unlisted managed role that has a manual grant or admin-added permissions, dropping only auto rows", async () => {
    const h = await makeHarness();
    await putUser(h, h.memberId, [TEAM_A]);
    await putUser(h, h.adminId, [TEAM_A]);
    await h.app.request(`/identity/users/${h.adminId}/roles`, jsonBody(asUser(h.adminId), "POST", { roleId: TEAM_A.id })); // pin manual
    const res = await putCatalog(h, []);
    expect(await res.json()).toMatchObject({ deleted: [], kept: [TEAM_A.id] });
    expect(await h.repo.getRole(TEAM_A.id)).not.toBeNull();
    expect((await rolesOf(h, h.memberId)).some((a) => a.roleId === TEAM_A.id)).toBe(false);
    expect((await rolesOf(h, h.adminId)).some((a) => a.roleId === TEAM_A.id)).toBe(true);
  });

  it("never touches admin-made roles", async () => {
    const h = await makeHarness();
    await putCatalog(h, []);
    expect(await h.repo.getRole(h.adminRoleId)).not.toBeNull();
    expect(await h.repo.getRole(h.memberRoleId)).not.toBeNull();
  });
});

describe("managed roles over D1 SQL (0026 source column)", () => {
  const migration = (f: string) => readFileSync(new URL(`../../../infra/d1/migrations/identity/${f}`, import.meta.url), "utf8");
  const TS = "2026-11-02T00:00:00.000Z";

  it("persists source, keeps manual rows, and prunes only auto rows", async () => {
    const { d1, raw } = makeOutboxD1();
    raw.exec(migration("0001_init.sql"));
    raw.exec("ALTER TABLE identity_users ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
    raw.exec("ALTER TABLE identity_users ADD COLUMN furigana TEXT");
    raw.exec(migration("0018_role_mail_visibility.sql"));
    raw.exec(migration("0026_role_assignment_source.sql"));
    raw.exec(`INSERT INTO identity_orgs (id, name, created_at) VALUES ('${ORG_ID}', 'DevHub', '${TS}')`);
    const repo = new D1IdentityRepo(createDbClient(d1, { namespace: "identity" }));
    for (const id of ["u_admin", "u_a"]) {
      await repo.createUser({ id, orgId: ORG_ID, email: `${id}@x.jp`, displayName: id, furigana: null, githubLogin: null, avatarUrl: null, status: "active", source: "manual", createdAt: TS, updatedAt: TS });
    }
    let n = 0;
    const svc = new IdentityService({ repo, audit: new FakeAudit(), revoker: new FakeRevoker(), now: () => TS, newId: (p: string) => `${p}_${++n}`, defaultOrgId: ORG_ID } as never);
    const ctx = { actorId: "u_admin", requestId: "r" };

    expect(await svc.syncUserManagedRoles("u_a", ORG_ID, { roles: [TEAM_A, LEAD] }, ctx)).toMatchObject({ added: [TEAM_A.id, LEAD.id] });
    const rows = raw.prepare("SELECT role_id, source, granted_by FROM identity_role_assignments ORDER BY role_id").all();
    expect(rows).toEqual([
      { role_id: LEAD.id, source: "auto:member-sync", granted_by: "u_admin" },
      { role_id: TEAM_A.id, source: "auto:member-sync", granted_by: "u_admin" },
    ]);

    // manual grant (no source column in the INSERT -> DEFAULT 'manual')
    await svc.assignRole("u_admin", ORG_ID, { roleId: LEAD.id }, ctx);
    await svc.syncUserManagedRoles("u_a", ORG_ID, { roles: [] }, ctx);
    const left = raw.prepare("SELECT user_id, role_id, source FROM identity_role_assignments").all();
    expect(left).toEqual([{ user_id: "u_admin", role_id: LEAD.id, source: "manual" }]);

    const cat = await svc.syncManagedRoleCatalog(ORG_ID, { roles: [] }, ctx);
    expect(cat).toMatchObject({ deleted: [TEAM_A.id], kept: [LEAD.id] });
  });
});
