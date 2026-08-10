import { describe, it, expect } from "vitest";
import { MemIdentityRepo } from "../src/repo/mem-repo";
import { seedDemoUsers } from "../src/seed";
import { IdentityService } from "../src/service";
import { ORG_ID } from "./harness";

function makeSeedDeps(repo: MemIdentityRepo) {
  let seq = 0;
  return {
    repo,
    now: (): string => "2026-08-11T00:00:00.000Z",
    newId: (p: string): string => `${p}_${String(++seq).padStart(6, "0")}`,
  };
}

function makeService(repo: MemIdentityRepo): IdentityService {
  return new IdentityService({
    repo,
    audit: { logSync: async () => {}, publish: async () => {} },
    revoker: { revokeUser: async () => {} },
    now: (): string => "2026-08-11T00:00:00.000Z",
    newId: (p: string): string => `${p}_x`,
    defaultOrgId: ORG_ID,
  });
}

describe("seedDemoUsers", () => {
  it("creates the 3 company-domain demo users (admin/maintainer/member) with their roles", async () => {
    const repo = new MemIdentityRepo();
    const seeded = await seedDemoUsers(makeSeedDeps(repo), ORG_ID);
    expect(seeded.map((s) => s.email).sort()).toEqual(["admin@developershub.jp", "maintainer@developershub.jp", "member@developershub.jp"]);

    const admin = (await repo.getUserByEmail(ORG_ID, "admin@developershub.jp"))!;
    const maintainer = (await repo.getUserByEmail(ORG_ID, "maintainer@developershub.jp"))!;
    const member = (await repo.getUserByEmail(ORG_ID, "member@developershub.jp"))!;
    expect(admin.status).toBe("active");
    expect(maintainer.status).toBe("active");
    expect(member.status).toBe("active");

    // roles resolve to the effective permissions.
    const svc = makeService(repo);
    // admin: full org administration
    expect(await svc.can(admin.id, ORG_ID, { permission: "identity:admin" })).toBe(true);
    // maintainer: can edit/operate but NOT administer identity/members
    expect(await svc.can(maintainer.id, ORG_ID, { permission: "task:delete" })).toBe(true);
    expect(await svc.can(maintainer.id, ORG_ID, { permission: "identity:admin" })).toBe(false);
    // member: general use only
    expect(await svc.can(member.id, ORG_ID, { permission: "identity:admin" })).toBe(false);
    expect(await svc.can(member.id, ORG_ID, { permission: "task:write" })).toBe(true);
  });

  it("is idempotent: re-seeding does not duplicate users or assignments", async () => {
    const repo = new MemIdentityRepo();
    await seedDemoUsers(makeSeedDeps(repo), ORG_ID);
    const adminBefore = (await repo.getUserByEmail(ORG_ID, "admin@developershub.jp"))!;
    const assignsBefore = await repo.listAssignmentsByUser(adminBefore.id, ORG_ID);

    await seedDemoUsers(makeSeedDeps(repo), ORG_ID);
    const adminAfter = (await repo.getUserByEmail(ORG_ID, "admin@developershub.jp"))!;
    const assignsAfter = await repo.listAssignmentsByUser(adminAfter.id, ORG_ID);

    expect(adminAfter.id).toBe(adminBefore.id);
    expect(assignsAfter.length).toBe(assignsBefore.length);
    const users = await repo.listUsers({ orgId: ORG_ID, limit: 100 });
    expect(users.items.filter((u) => u.email === "admin@developershub.jp").length).toBe(1);
  });

  it("provision (invite-only) accepts the seeded demo user by email", async () => {
    const repo = new MemIdentityRepo();
    await seedDemoUsers(makeSeedDeps(repo), ORG_ID);
    const svc = makeService(repo);
    // password login resolves the canonical user via provision(email) — must succeed.
    const result = await svc.provision(ORG_ID, { email: "admin@developershub.jp", displayName: "Demo Admin" }, { requestId: "req_t", actorId: null });
    expect(result.status).toBe("existing");
    expect(result.user?.email).toBe("admin@developershub.jp");
  });
});
