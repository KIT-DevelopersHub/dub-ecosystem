// permissionHolders — notification audience fan-out (notif:receive_*) + 通知管理「誰に届くか」.
// Run against BOTH repos (mem + D1's real SQL over node:sqlite seeded with identity 0001).
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
import { FakeAudit, FakeRevoker } from "./harness";

const ORG = "org_devhub";
const TS = "2026-08-09T00:00:00.000Z";
const KEY = "notif:receive_admin" as const;

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

  await role("r_admin", [KEY, "notif:receive_all"]);
  await role("r_ops", [KEY]);
  await role("r_member", ["notif:receive_all"]);
  for (const id of ["u_a", "u_b", "u_c", "u_d"]) await user(id);
  await user("u_off", "disabled");
  await assign("u_a", "r_admin");
  await assign("u_a", "r_ops"); // two holding roles: still one id
  await assign("u_b", "r_ops");
  await assign("u_c", "r_member");
  await assign("u_d", "r_ops", "event", "ev_1"); // event-scoped only: not a holder
  await assign("u_off", "r_admin"); // inactive: counted as a role member, never a recipient
}

function svcOver(repo: IdentityRepo) {
  let n = 0;
  return new IdentityService({ repo, audit: new FakeAudit(), revoker: new FakeRevoker(), now: () => TS, newId: (p: string) => `${p}_${++n}`, defaultOrgId: ORG } as never);
}

for (const [name, make] of [["mem", () => new MemIdentityRepo()], ["d1", d1Repo]] as const) {
  describe(`permissionHolders (${name} repo)`, () => {
    it("lists the roles carrying the key and the distinct active org-wide holders", async () => {
      const repo = make();
      await seed(repo);
      const out = await svcOver(repo).permissionHolders(ORG, KEY);
      expect(out.permission).toBe(KEY);
      expect(out.roles.map((r) => r.id).sort()).toEqual(["r_admin", "r_ops"]);
      expect(out.userIds).toEqual(["u_a", "u_b"]);
      expect(out.roles.find((r) => r.id === "r_admin")?.memberCount).toBe(2);
    });

    it("a key no role holds resolves to nobody (not an error)", async () => {
      const repo = make();
      await seed(repo);
      expect(await svcOver(repo).permissionHolders(ORG, "notif:broadcast_publish")).toEqual({
        permission: "notif:broadcast_publish",
        roles: [],
        userIds: [],
      });
    });

    it("rejects a key outside the catalog", async () => {
      const repo = make();
      await seed(repo);
      const err = await svcOver(repo).permissionHolders(ORG, "notif:nope").catch((e: unknown) => e);
      expect(isDubError(err)).toBe(true);
    });
  });
}
