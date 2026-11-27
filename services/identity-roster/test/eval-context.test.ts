// loadEvalContext reads every role of the user in one query (getRolesByIds) instead of
// getRole + permissionsOf per role. Semantics run against BOTH repos; the D1 side also pins
// the query count so the per-role N+1 does not come back.
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
const TS = "2026-11-22T00:00:00.000Z";

function d1Repo(): { repo: IdentityRepo; queries: string[] } {
  const { d1, raw } = makeOutboxD1();
  raw.exec(readFileSync(new URL("../../../infra/d1/migrations/identity/0001_init.sql", import.meta.url), "utf8"));
  raw.exec("ALTER TABLE identity_users ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
  raw.exec("ALTER TABLE identity_users ADD COLUMN furigana TEXT");
  raw.exec(`INSERT INTO identity_orgs (id, name, created_at) VALUES ('${ORG}', 'DevHub', '${TS}')`);
  const queries: string[] = [];
  const prepare = d1.prepare.bind(d1);
  (d1 as { prepare: typeof d1.prepare }).prepare = (sql: string) => {
    queries.push(sql);
    return prepare(sql);
  };
  return { repo: new D1IdentityRepo(createDbClient(d1, { namespace: "identity" })), queries };
}

async function seed(repo: IdentityRepo) {
  const role = (id: string, perms: identity.PermissionKey[]) =>
    repo.createRole({ id, orgId: ORG, name: id, isSystem: false, permissions: perms, createdAt: TS, updatedAt: TS });
  const user = (id: string, status: identity.UserStatus = "active") =>
    repo.createUser({ id, orgId: ORG, email: `${id}@x.jp`, displayName: id, furigana: null, githubLogin: null, avatarUrl: null, status, source: "manual", createdAt: TS, updatedAt: TS });
  let n = 0;
  const assign = (userId: string, roleId: string, rt: string | null = null, ri: string | null = null) =>
    repo.createAssignment({ id: `ra_${++n}`, userId, roleId, orgId: ORG, resourceType: rt, resourceId: ri, grantedBy: "u_a", grantedAt: TS });

  await role("r_mail", ["mail:read", "mail:send"]);
  await role("r_all", ["mail:read_all"]);
  await role("r_empty", []);
  await role("r_event", ["identity:read"]);
  await user("u_a");
  await user("u_off", "disabled");
  await assign("u_a", "r_mail");
  await assign("u_a", "r_empty");
  await assign("u_a", "r_event", "event", "ev_1"); // scoped: only for ev_1
  await assign("u_off", "r_all");
}

function svcOver(repo: IdentityRepo) {
  let n = 0;
  return new IdentityService({ repo, audit: new FakeAudit(), revoker: new FakeRevoker(), now: () => TS, newId: (p: string) => `${p}_${++n}`, defaultOrgId: ORG } as never);
}

const allowed = async (svc: IdentityService, userId: string, checks: identity.AuthzQuery[]) =>
  (await svc.authzCheck({ subjectUserId: userId, orgId: ORG, checks } as identity.AuthzCheckRequest)).decisions.map((d) => d.allowed);

for (const [name, make] of [["mem", () => ({ repo: new MemIdentityRepo() as IdentityRepo, queries: [] as string[] })], ["d1", d1Repo]] as const) {
  describe(`eval context (${name} repo)`, () => {
    it("getRolesByIds returns each known role once with its permissions, unknown ids absent", async () => {
      const { repo } = make();
      await seed(repo);
      const roles = await repo.getRolesByIds(["r_mail", "r_empty", "r_mail", "r_missing"]);
      const byId = Object.fromEntries(roles.map((r) => [r.id, [...r.permissions].sort()]));
      expect(byId).toEqual({ r_mail: ["mail:read", "mail:send"], r_empty: [] });
      for (const r of roles) expect(r).toEqual({ ...(await repo.getRole(r.id))!, permissions: expect.any(Array) });
      expect(await repo.getRolesByIds([])).toEqual([]);
    });

    it("authz decisions are unchanged: org-wide, scoped and dangerous keys", async () => {
      const { repo } = make();
      await seed(repo);
      const svc = svcOver(repo);
      expect(
        await allowed(svc, "u_a", [
          { permission: "mail:read" },
          { permission: "mail:send" },
          { permission: "mail:read_all" },
          { permission: "identity:read" },
          { permission: "identity:read", resourceType: "event", resourceId: "ev_1" },
          { permission: "identity:read", resourceType: "event", resourceId: "ev_2" },
        ] as identity.AuthzQuery[]),
      ).toEqual([true, true, false, false, true, false]);
      // An inactive holder of mail:read_all is denied.
      expect(await allowed(svc, "u_off", [{ permission: "mail:read_all" } as identity.AuthzQuery])).toEqual([false]);
      expect((await svc.effectivePermissions("u_a", ORG)).permissions.sort()).toEqual(["mail:read", "mail:send"]);
      expect((await svc.effectivePermissions("u_off", ORG)).permissions).toEqual([]);
    });

    it("getRolesByIds narrowed to onlyPermissions keeps every role but only the asked keys", async () => {
      const { repo } = make();
      await seed(repo);
      const byId = async (only: string[]) =>
        Object.fromEntries((await repo.getRolesByIds(["r_mail", "r_empty", "r_all"], only)).map((r) => [r.id, [...r.permissions].sort()]));
      expect(await byId(["mail:send", "identity:read"])).toEqual({ r_mail: ["mail:send"], r_empty: [], r_all: [] });
      expect(await byId([])).toEqual({ r_mail: [], r_empty: [], r_all: [] });
    });

    it("the in-process gate's narrowed read equals effectivePermissions ∩ keys", async () => {
      const { repo } = make();
      await seed(repo);
      const svc = svcOver(repo);
      const keys = ["mail:send", "mail:read_all", "identity:read"];
      expect((await svc.heldOrgWidePermissions("u_a", ORG, keys)).sort()).toEqual(["mail:send"]);
      expect(await svc.heldOrgWidePermissions("u_off", ORG, keys)).toEqual([]);
    });
  });
}

describe("narrowed role read (d1)", () => {
  it("authz/check binds only the asked keys into the role read", async () => {
    const { repo, queries } = d1Repo();
    await seed(repo);
    const svc = svcOver(repo);
    queries.length = 0;
    expect(await allowed(svc, "u_a", [{ permission: "mail:send" } as identity.AuthzQuery])).toEqual([true]);
    const roleRead = queries.find((q) => q.includes("LEFT JOIN identity_role_permissions"));
    expect(roleRead).toContain("rp.permission_key IN (?)");
  });
});

describe("eval context query count (d1)", () => {
  it("loads user + assignments + all roles in 3 queries regardless of role count", async () => {
    const { repo, queries } = d1Repo();
    await seed(repo);
    const svc = svcOver(repo);
    queries.length = 0;
    await svc.effectivePermissions("u_a", ORG);
    expect(queries).toHaveLength(3);
  });
});
