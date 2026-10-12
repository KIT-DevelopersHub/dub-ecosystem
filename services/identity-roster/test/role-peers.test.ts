// GET /internal/users/:id/role-peers — mail-gateway's role-shared inbound scope. Semantics
// are run against BOTH repos: MemIdentityRepo via the service, and D1IdentityRepo's real SQL
// over node:sqlite seeded with the identity 0001 DDL.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { isDubError } from "@dub/errors";
import { createDbClient } from "@dub/db";
import type { identity } from "@dub/types";
import { IdentityService } from "../src/service";
import { MemIdentityRepo } from "../src/repo/mem-repo";
import { D1IdentityRepo } from "../src/repo/d1-repo";
import type { IdentityRepo } from "../src/repo/types";
import { makeOutboxD1 } from "./outbox-d1";
import { FakeAudit, FakeRevoker, makeHarness, internal } from "./harness";

const ORG = "org_devhub";
const TS = "2026-08-09T00:00:00.000Z";
const SHARE = "mail:read_role_shared" as const;

function d1Repo(): IdentityRepo {
  const { d1, raw } = makeOutboxD1();
  raw.exec(readFileSync(new URL("../../../infra/d1/migrations/identity/0001_init.sql", import.meta.url), "utf8"));
  raw.exec("ALTER TABLE identity_users ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
  raw.exec("ALTER TABLE identity_users ADD COLUMN furigana TEXT");
  raw.exec(`INSERT INTO identity_orgs (id, name, created_at) VALUES ('${ORG}', 'DevHub', '${TS}')`);
  return new D1IdentityRepo(createDbClient(d1, { namespace: "identity" }));
}

async function seed(repo: IdentityRepo) {
  const role = (id: string, perms: identity.PermissionKey[]) =>
    repo.createRole({ id, orgId: ORG, name: id, isSystem: false, permissions: perms, createdAt: TS, updatedAt: TS });
  const user = (id: string, status: identity.UserStatus = "active") =>
    repo.createUser({ id, orgId: ORG, email: `${id}@x.jp`, displayName: id, furigana: null, githubLogin: null, avatarUrl: null, status, source: "manual", createdAt: TS, updatedAt: TS });
  let n = 0;
  const assign = (userId: string, roleId: string, rt: string | null = null, ri: string | null = null) =>
    repo.createAssignment({ id: `ra_${++n}`, userId, roleId, orgId: ORG, resourceType: rt, resourceId: ri, grantedBy: "u_a", grantedAt: TS });

  await role("r_shared", ["mail:read", SHARE]);
  await role("r_plain", ["mail:read"]);
  for (const id of ["u_a", "u_b", "u_c", "u_d", "u_e"]) await user(id);
  await user("u_off", "disabled");
  await assign("u_a", "r_shared");
  await assign("u_a", "r_plain");
  await assign("u_b", "r_shared"); // shared peer
  await assign("u_b", "r_shared", "event", "ev_1"); // duplicate scoped grant: still one id
  await assign("u_c", "r_plain"); // only the non-sharing role
  await assign("u_d", "r_shared", "event", "ev_1"); // scoped only: ignored
  await assign("u_e", "r_plain", "event", "ev_1");
  await assign("u_e", "r_shared"); // shares through r_shared
  await assign("u_off", "r_shared"); // inactive peer: excluded
}

function svcOver(repo: IdentityRepo) {
  let n = 0;
  return new IdentityService({ repo, audit: new FakeAudit(), revoker: new FakeRevoker(), now: () => TS, newId: (p: string) => `${p}_${++n}`, defaultOrgId: ORG } as never);
}

for (const [name, make] of [["mem", () => new MemIdentityRepo()], ["d1", d1Repo]] as const) {
  describe(`rolePeers (${name} repo)`, () => {
    it("returns other org-wide holders of the caller's sharing roles only, self excluded", async () => {
      const repo = make();
      await seed(repo);
      const svc = svcOver(repo);
      expect(await svc.rolePeers("u_a", ORG, SHARE)).toEqual({ userIds: ["u_b", "u_e"] });
    });

    it("a user holding only a non-sharing role has no peers", async () => {
      const repo = make();
      await seed(repo);
      expect(await svcOver(repo).rolePeers("u_c", ORG, SHARE)).toEqual({ userIds: [] });
    });

    it("an event-scoped grant of the sharing role does not count for the caller", async () => {
      const repo = make();
      await seed(repo);
      expect(await svcOver(repo).rolePeers("u_d", ORG, SHARE)).toEqual({ userIds: [] });
    });

    it("an inactive caller has no peers", async () => {
      const repo = make();
      await seed(repo);
      expect(await svcOver(repo).rolePeers("u_off", ORG, SHARE)).toEqual({ userIds: [] });
    });
  });
}

describe("GET /internal/users/:id/role-peers", () => {
  it("rejects a permission outside the catalog with 400", async () => {
    const h = await makeHarness();
    const res = await h.app.request(`/internal/users/${h.memberId}/role-peers?permission=mail:nope`, internal());
    expect(res.status).toBe(400);
    const svc = svcOver(new MemIdentityRepo());
    await expect(svc.rolePeers("u", ORG, "")).rejects.toSatisfy(isDubError);
  });

  it("serves { userIds } over the internal marker", async () => {
    const h = await makeHarness();
    const res = await h.app.request(`/internal/users/${h.memberId}/role-peers?permission=${SHARE}`, internal());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userIds: [] }); // no system role carries the key for member
  });
});
