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
  it("creates admin@dub.local and member@dub.local as active users with their roles", async () => {
    const repo = new MemIdentityRepo();
    const seeded = await seedDemoUsers(makeSeedDeps(repo), ORG_ID);
    expect(seeded.map((s) => s.email).sort()).toEqual(["admin@dub.local", "member@dub.local"]);

    const admin = (await repo.getUserByEmail(ORG_ID, "admin@dub.local"))!;
    const member = (await repo.getUserByEmail(ORG_ID, "member@dub.local"))!;
    expect(admin.status).toBe("active");
    expect(member.status).toBe("active");

    // roles resolve to the effective permissions (admin holds identity:admin; member does not)
    const svc = makeService(repo);
    expect(await svc.can(admin.id, ORG_ID, { permission: "identity:admin" })).toBe(true);
    expect(await svc.can(member.id, ORG_ID, { permission: "identity:admin" })).toBe(false);
    expect(await svc.can(member.id, ORG_ID, { permission: "task:write" })).toBe(true);
  });

  it("is idempotent: re-seeding does not duplicate users or assignments", async () => {
    const repo = new MemIdentityRepo();
    await seedDemoUsers(makeSeedDeps(repo), ORG_ID);
    const adminBefore = (await repo.getUserByEmail(ORG_ID, "admin@dub.local"))!;
    const assignsBefore = await repo.listAssignmentsByUser(adminBefore.id, ORG_ID);

    await seedDemoUsers(makeSeedDeps(repo), ORG_ID);
    const adminAfter = (await repo.getUserByEmail(ORG_ID, "admin@dub.local"))!;
    const assignsAfter = await repo.listAssignmentsByUser(adminAfter.id, ORG_ID);

    expect(adminAfter.id).toBe(adminBefore.id);
    expect(assignsAfter.length).toBe(assignsBefore.length);
    const users = await repo.listUsers({ orgId: ORG_ID, limit: 100 });
    expect(users.items.filter((u) => u.email === "admin@dub.local").length).toBe(1);
  });

  it("provision (invite-only) accepts the seeded demo user by email", async () => {
    const repo = new MemIdentityRepo();
    await seedDemoUsers(makeSeedDeps(repo), ORG_ID);
    const svc = makeService(repo);
    // password login resolves the canonical user via provision(email) — must succeed.
    const result = await svc.provision(ORG_ID, { email: "admin@dub.local", displayName: "Demo Admin" }, { requestId: "req_t", actorId: null });
    expect(result.status).toBe("existing");
    expect(result.user?.email).toBe("admin@dub.local");
  });
});
