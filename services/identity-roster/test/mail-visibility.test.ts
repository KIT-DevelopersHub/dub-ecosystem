// Cross-role mail visibility: a role's holders also see the inbound mail of a target role's
// holders (identity_role_mail_visibility). `mailVisibleUsers` (GET /internal/users/:id/
// mail-visible-users) unions it with same-role sharing. Run against BOTH repos: Mem via the
// service, and D1's real SQL over node:sqlite seeded with the 0001 + 0017 DDL.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { createDbClient } from "@dub/db";
import type { identity } from "@dub/types";
import { IdentityService } from "../src/service";
import { MemIdentityRepo } from "../src/repo/mem-repo";
import { D1IdentityRepo } from "../src/repo/d1-repo";
import type { IdentityRepo } from "../src/repo/types";
import { makeOutboxD1 } from "./outbox-d1";
import { FakeAudit, FakeRevoker, makeHarness, internal } from "./harness";

const ORG = "org_devhub";
const TS = "2026-10-12T00:00:00.000Z";
const CTX = { actorId: "u_admin", requestId: "req_1" } as never;
const migration = (f: string) => readFileSync(new URL(`../../../infra/d1/migrations/identity/${f}`, import.meta.url), "utf8");

function d1Repo(): IdentityRepo {
  const { d1, raw } = makeOutboxD1();
  raw.exec(migration("0001_init.sql"));
  raw.exec("ALTER TABLE identity_users ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
  raw.exec("ALTER TABLE identity_users ADD COLUMN furigana TEXT");
  raw.exec(migration("0017_role_mail_visibility.sql"));
  raw.exec(`INSERT INTO identity_orgs (id, name, created_at) VALUES ('${ORG}', 'DevHub', '${TS}')`);
  return new D1IdentityRepo(createDbClient(d1, { namespace: "identity" }));
}

// r_lead (統括) sees r_sponsor + r_pr; r_sponsor shares within itself; r_pr has nothing.
async function seed(repo: IdentityRepo) {
  if (!(await repo.getOrg(ORG))) await repo.createOrg({ id: ORG, name: "DevHub", createdAt: TS });
  const role = (id: string, perms: identity.PermissionKey[]) =>
    repo.createRole({ id, orgId: ORG, name: id, isSystem: false, permissions: perms, createdAt: TS, updatedAt: TS });
  const user = (id: string, status: identity.UserStatus = "active") =>
    repo.createUser({ id, orgId: ORG, email: `${id}@x.jp`, displayName: id, furigana: null, githubLogin: null, avatarUrl: null, status, source: "manual", createdAt: TS, updatedAt: TS });
  let n = 0;
  const assign = (userId: string, roleId: string, rt: string | null = null, ri: string | null = null) =>
    repo.createAssignment({ id: `ra_${++n}`, userId, roleId, orgId: ORG, resourceType: rt, resourceId: ri, grantedBy: "u_lead", grantedAt: TS });

  await role("r_lead", ["mail:read"]);
  await role("r_sponsor", ["mail:read", "mail:read_role_shared"]);
  await role("r_pr", ["mail:read"]);
  for (const id of ["u_lead", "u_s1", "u_s2", "u_pr", "u_scoped"]) await user(id);
  await user("u_off", "disabled");
  await assign("u_lead", "r_lead");
  await assign("u_s1", "r_sponsor");
  await assign("u_s2", "r_sponsor");
  await assign("u_pr", "r_pr");
  await assign("u_scoped", "r_pr", "event", "ev_1"); // event-scoped holder: not visible
  await assign("u_off", "r_pr"); // inactive holder: not visible
  await repo.updateRolePermissions("r_lead", undefined, undefined, TS, ["r_sponsor", "r_pr"]);
}

function svcOver(repo: IdentityRepo) {
  let n = 0;
  return new IdentityService({ repo, audit: new FakeAudit(), revoker: new FakeRevoker(), now: () => TS, newId: (p: string) => `${p}_${++n}`, defaultOrgId: ORG } as never);
}

for (const [name, make] of [["mem", () => new MemIdentityRepo()], ["d1", d1Repo]] as const) {
  describe(`mailVisibleUsers (${name} repo)`, () => {
    it("a viewer role sees every org-wide active holder of its target roles", async () => {
      const repo = make();
      await seed(repo);
      expect(await svcOver(repo).mailVisibleUsers("u_lead", ORG)).toEqual({ userIds: ["u_pr", "u_s1", "u_s2"] });
    });

    it("is directional: a target role's holder does not see the viewer", async () => {
      const repo = make();
      await seed(repo);
      expect(await svcOver(repo).mailVisibleUsers("u_pr", ORG)).toEqual({ userIds: [] });
    });

    it("still includes same-role sharing peers", async () => {
      const repo = make();
      await seed(repo);
      expect(await svcOver(repo).mailVisibleUsers("u_s1", ORG)).toEqual({ userIds: ["u_s2"] });
    });

    it("an inactive caller sees no one else", async () => {
      const repo = make();
      await seed(repo);
      await repo.updateRolePermissions("r_pr", undefined, undefined, TS, ["r_sponsor"]);
      expect(await svcOver(repo).mailVisibleUsers("u_off", ORG)).toEqual({ userIds: [] });
    });

    it("listRoles exposes mailVisibleRoleIds and updateRole replaces the set", async () => {
      const repo = make();
      await seed(repo);
      const svc = svcOver(repo);
      const byId = async () => new Map((await svc.listRoles(ORG)).items.map((r) => [r.id, r.mailVisibleRoleIds]));
      expect((await byId()).get("r_lead")).toEqual(["r_pr", "r_sponsor"]);
      expect((await byId()).get("r_pr")).toEqual([]);

      const updated = await svc.updateRole("r_lead", ORG, { mailVisibleRoleIds: ["r_pr"] }, CTX);
      expect(updated.mailVisibleRoleIds).toEqual(["r_pr"]);
      expect(await svc.mailVisibleUsers("u_lead", ORG)).toEqual({ userIds: ["u_pr"] });

      // Omitting the field leaves the set untouched.
      await svc.updateRole("r_lead", ORG, { name: "統括" }, CTX);
      expect((await byId()).get("r_lead")).toEqual(["r_pr"]);
    });

    it("deleting a target role drops it from every viewer's set", async () => {
      const repo = make();
      await seed(repo);
      const svc = svcOver(repo);
      await svc.deleteRole("r_pr", ORG, CTX);
      expect((await svc.listRoles(ORG)).items.find((r) => r.id === "r_lead")?.mailVisibleRoleIds).toEqual(["r_sponsor"]);
    });

    it("rejects the role itself and unknown roles", async () => {
      const repo = make();
      await seed(repo);
      const svc = svcOver(repo);
      await expect(svc.updateRole("r_lead", ORG, { mailVisibleRoleIds: ["r_lead"] }, CTX)).rejects.toMatchObject({ status: 400 });
      await expect(svc.updateRole("r_lead", ORG, { mailVisibleRoleIds: ["r_nope"] }, CTX)).rejects.toMatchObject({ status: 400 });
      expect((await svc.listRoles(ORG)).items.find((r) => r.id === "r_lead")?.mailVisibleRoleIds).toEqual(["r_pr", "r_sponsor"]);
    });

    it("createRole accepts an initial set", async () => {
      const repo = make();
      await seed(repo);
      const created = await svcOver(repo).createRole(ORG, { name: "新ロール", permissions: ["mail:read"], mailVisibleRoleIds: ["r_pr"] }, CTX);
      expect(created.mailVisibleRoleIds).toEqual(["r_pr"]);
    });
  });
}

describe("GET /internal/users/:id/mail-visible-users", () => {
  it("serves { userIds } over the internal marker", async () => {
    const h = await makeHarness();
    const res = await h.app.request(`/internal/users/${h.memberId}/mail-visible-users`, internal());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userIds: [] });
  });
});
