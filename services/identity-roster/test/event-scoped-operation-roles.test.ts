// 運営ロール (Organizer / 名簿のチーム) をイベント単位へ移した後の状態 = 団体全体の行が無く、イベント単位の
// 行だけがある状態で、アプリ権限・通知の宛先・ロールのメール共有・名簿の自動同期が変わらないこと。
// システム系ロール (admin / 手作りロール) はイベント単位で持っても団体全体には数えない。
// mem と D1 (node:sqlite 上の実 SQL) の両方で回す。
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { createDbClient } from "@dub/db";
import type { identity } from "@dub/types";
import { IdentityService } from "../src/service";
import { MemIdentityRepo } from "../src/repo/mem-repo";
import { D1IdentityRepo } from "../src/repo/d1-repo";
import type { IdentityRepo } from "../src/repo/types";
import { makeOutboxD1 } from "./outbox-d1";
import { FakeAudit, FakeRevoker } from "./harness";

const ORG = "org_devhub";
const TS = "2026-11-27T00:00:00.000Z";
const EVENT = "ev_2027";
const OTHER_EVENT = "ev_other";
const ORGANIZER = "role_sys_organizer";
const SPONSOR_TEAM = "role_auto_team_sponsor";
const PR_TEAM = "role_auto_team_pr";
const MEMBER = "role_sys_member";
const HR = "role_hr"; // 手作りのシステム系ロール (人事)
const ADMIN = "role_sys_admin";

const migration = (f: string) => readFileSync(new URL(`../../../infra/d1/migrations/identity/${f}`, import.meta.url), "utf8");

function d1Repo(): IdentityRepo {
  const { d1, raw } = makeOutboxD1();
  raw.exec(migration("0001_init.sql"));
  raw.exec("ALTER TABLE identity_users ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
  raw.exec("ALTER TABLE identity_users ADD COLUMN furigana TEXT");
  raw.exec(migration("0018_role_mail_visibility.sql"));
  raw.exec(migration("0026_role_assignment_source.sql"));
  raw.exec(`INSERT INTO identity_orgs (id, name, created_at) VALUES ('${ORG}', 'DevHub', '${TS}')`);
  return new D1IdentityRepo(createDbClient(d1, { namespace: "identity" }));
}

/** A_apply.sql 相当: 運営ロールはイベント単位だけ。member は団体全体。 */
async function seed(repo: IdentityRepo) {
  const role = (id: string, perms: identity.PermissionKey[], isSystem = false) =>
    repo.createRole({ id, orgId: ORG, name: id, isSystem, permissions: perms, createdAt: TS, updatedAt: TS });
  await role(ORGANIZER, ["app:events:edit", "app:events:view", "event:write", "event:read"], true);
  await role(SPONSOR_TEAM, ["app:sponsor:view", "app:sponsor:edit", "sponsor:read", "sponsor:write", "mail:read_role_shared", "notif:receive_all"]);
  await role(PR_TEAM, []);
  await role(MEMBER, ["app:tasks:view"], true);
  await role(HR, ["app:members:edit"]);
  await role(ADMIN, ["identity:admin", "notif:receive_admin"], true);
  for (const id of ["u_org", "u_sp1", "u_sp2", "u_hr", "u_new"]) {
    await repo.createUser({ id, orgId: ORG, email: `${id}@x.jp`, displayName: id, furigana: null, githubLogin: null, avatarUrl: null, status: "active", source: "manual", createdAt: TS, updatedAt: TS });
  }
  let n = 0;
  const assign = (userId: string, roleId: string, ri: string | null, source: identity.RoleAssignmentSource = "manual") =>
    repo.createAssignment({ id: `seed_${++n}`, userId, roleId, orgId: ORG, resourceType: ri ? "event" : null, resourceId: ri, grantedBy: "u_org", grantedAt: TS, source });
  for (const u of ["u_org", "u_sp1", "u_sp2", "u_hr", "u_new"]) await assign(u, MEMBER, null);
  await assign("u_org", ORGANIZER, EVENT);
  await assign("u_sp1", SPONSOR_TEAM, EVENT, "auto:member-sync");
  await assign("u_sp2", SPONSOR_TEAM, EVENT, "auto:member-sync");
  await assign("u_sp1", PR_TEAM, EVENT, "auto:member-sync");
  await assign("u_hr", HR, EVENT); // system-ish role given per event: not org-wide
  await assign("u_hr", ADMIN, EVENT);
}

function svcOver(repo: IdentityRepo) {
  let n = 0;
  return new IdentityService({ repo, audit: new FakeAudit(), revoker: new FakeRevoker(), now: () => TS, newId: (p: string) => `${p}_${++n}`, defaultOrgId: ORG } as never);
}
const ctx = { actorId: "u_org", requestId: "r" };

for (const [name, make] of [["mem", () => new MemIdentityRepo()], ["d1", d1Repo]] as const) {
  describe(`event-scoped operation roles (${name})`, () => {
    it("Organizer / チーム held only per event keep their apps (/me, gate)", async () => {
      const repo = make();
      await seed(repo);
      const svc = svcOver(repo);
      expect((await svc.effectivePermissions("u_org", ORG)).permissions).toEqual(expect.arrayContaining(["app:events:edit", "event:write", "app:tasks:view"]));
      expect((await svc.effectivePermissions("u_sp1", ORG)).permissions).toEqual(expect.arrayContaining(["app:sponsor:edit", "sponsor:write"]));
      expect(await svc.heldOrgWidePermissions("u_sp1", ORG, ["app:sponsor:view", "sponsor:read"])).toEqual(expect.arrayContaining(["app:sponsor:view", "sponsor:read"]));
      const res = await svc.authzCheck({ subjectUserId: "u_org", orgId: ORG, checks: [{ permission: "app:events:edit" }, { permission: "event:write" }] });
      expect(res.decisions.map((d) => d.allowed)).toEqual([true, true]);
    });

    it("a question naming an event still matches only that event's assignment", async () => {
      const repo = make();
      await seed(repo);
      const svc = svcOver(repo);
      const res = await svc.authzCheck({
        subjectUserId: "u_org",
        orgId: ORG,
        checks: [
          { permission: "event:write", resourceType: "event", resourceId: EVENT },
          { permission: "event:write", resourceType: "event", resourceId: OTHER_EVENT },
        ],
      });
      expect(res.decisions.map((d) => d.allowed)).toEqual([true, false]);
    });

    it("system roles held per event stay out of the org-wide answer", async () => {
      const repo = make();
      await seed(repo);
      const svc = svcOver(repo);
      const perms = (await svc.effectivePermissions("u_hr", ORG)).permissions;
      expect(perms).not.toContain("app:members:edit");
      expect(perms).not.toContain("identity:admin");
      const res = await svc.authzCheck({ subjectUserId: "u_hr", orgId: ORG, checks: [{ permission: "identity:admin" }, { permission: "app:members:edit" }] });
      expect(res.decisions.map((d) => d.allowed)).toEqual([false, false]);
      expect((await svc.permissionHolders(ORG, "notif:receive_admin")).userIds).toEqual([]);
    });

    it("notification audiences count the team's per-event holders", async () => {
      const repo = make();
      await seed(repo);
      const svc = svcOver(repo);
      expect((await svc.permissionHolders(ORG, "notif:receive_all")).userIds).toEqual(["u_sp1", "u_sp2"]);
      expect((await svc.permissionHolders(ORG, "app:sponsor:edit")).userIds).toEqual(["u_sp1", "u_sp2"]);
    });

    it("the team's shared mail still reaches its per-event members", async () => {
      const repo = make();
      await seed(repo);
      const svc = svcOver(repo);
      expect((await svc.rolePeers("u_sp1", ORG, "mail:read_role_shared")).userIds).toEqual(["u_sp2"]);
      expect((await svc.mailVisibleUsers("u_sp2", ORG)).userIds).toEqual(["u_sp1"]);
    });

    it("名簿 sync: a per-event auto row satisfies the team (no org-wide duplicate)", async () => {
      const repo = make();
      await seed(repo);
      const svc = svcOver(repo);
      const out = await svc.syncUserManagedRoles("u_sp1", ORG, { roles: [{ id: SPONSOR_TEAM, name: "チーム: スポンサー" }, { id: PR_TEAM, name: "チーム: 広報" }] }, ctx);
      expect(out).toMatchObject({ added: [], removed: [], manual: [] });
      const rows = (await repo.listAssignmentsByUser("u_sp1", ORG)).filter((a) => a.roleId === SPONSOR_TEAM);
      expect(rows.map((a) => [a.resourceType, a.resourceId])).toEqual([["event", EVENT]]);
    });

    it("名簿 sync: leaving the team removes the per-event auto row", async () => {
      const repo = make();
      await seed(repo);
      const svc = svcOver(repo);
      const out = await svc.syncUserManagedRoles("u_sp1", ORG, { roles: [{ id: SPONSOR_TEAM, name: "チーム: スポンサー" }] }, ctx);
      expect(out).toMatchObject({ added: [], removed: [PR_TEAM] });
      expect((await repo.listAssignmentsByUser("u_sp1", ORG)).some((a) => a.roleId === PR_TEAM)).toBe(false);
    });

    it("名簿 sync: a new team member joins the event the team runs", async () => {
      const repo = make();
      await seed(repo);
      const svc = svcOver(repo);
      const out = await svc.syncUserManagedRoles("u_new", ORG, { roles: [{ id: SPONSOR_TEAM, name: "チーム: スポンサー" }, { id: "role_auto_position_leader", name: "役職: Lead" }] }, ctx);
      expect(out).toMatchObject({ added: [SPONSOR_TEAM, "role_auto_position_leader"] });
      const rows = await repo.listAssignmentsByUser("u_new", ORG);
      expect(rows.find((a) => a.roleId === SPONSOR_TEAM)).toMatchObject({ resourceType: "event", resourceId: EVENT, source: "auto:member-sync" });
      // 役職 is a system-side role: org-wide as before.
      expect(rows.find((a) => a.roleId === "role_auto_position_leader")).toMatchObject({ resourceType: null, resourceId: null });
      expect((await svc.effectivePermissions("u_new", ORG)).permissions).toContain("app:sponsor:edit");
    });
  });
}
