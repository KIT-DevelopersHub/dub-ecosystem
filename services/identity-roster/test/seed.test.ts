import { describe, it, expect } from "vitest";
import { identity } from "@dub/types";
import { MemIdentityRepo } from "../src/repo/mem-repo";
import { seedReferenceData } from "../src/seed";
import { ORG_ID } from "./harness";

function makeDeps(repo: MemIdentityRepo) {
  let seq = 0;
  return {
    repo,
    now: (): string => "2026-08-09T00:00:00.000Z",
    newId: (p: string): string => `${p}_${String(++seq).padStart(6, "0")}`,
  };
}

describe("seedReferenceData / system roles", () => {
  it("grants the admin role every key in PERMISSION_CATALOG (drift-proof)", async () => {
    const repo = new MemIdentityRepo();
    await seedReferenceData(makeDeps(repo), ORG_ID);

    const admin = (await repo.getRoleByName(ORG_ID, "admin"))!;
    const catalogKeys = identity.PERMISSION_CATALOG.map((e) => e.key);

    // admin ⊇ PERMISSION_CATALOG: every frozen key is present.
    const adminKeys = new Set(admin.permissions);
    for (const key of catalogKeys) {
      expect(adminKeys.has(key), `admin is missing catalog key ${key}`).toBe(true);
    }
    // and no phantom keys beyond the catalog (exact set match).
    expect([...adminKeys].sort()).toEqual([...catalogKeys].sort());
  });

  it("seeds the default org + the system roles (incl. maintainer)", async () => {
    const repo = new MemIdentityRepo();
    await seedReferenceData(makeDeps(repo), ORG_ID);

    expect(await repo.getOrg(ORG_ID)).toBeTruthy();
    for (const name of ["admin", "maintainer", "organizer", "member"]) {
      const role = await repo.getRoleByName(ORG_ID, name);
      expect(role, `${name} role should be seeded`).toBeTruthy();
      expect(role!.isSystem).toBe(true);
    }
  });

  it("maintainer has operational power but NOT org administration", async () => {
    const repo = new MemIdentityRepo();
    await seedReferenceData(makeDeps(repo), ORG_ID);
    const maintainer = (await repo.getRoleByName(ORG_ID, "maintainer"))!;
    const perms = new Set(maintainer.permissions);
    // can do operations + editing
    expect(perms.has("event:write")).toBe(true);
    expect(perms.has("task:delete")).toBe(true);
    expect(perms.has("infra:deploy")).toBe(true);
    // cannot administer identity/roles, org infra, or member permissions
    expect(perms.has("identity:admin")).toBe(false);
    expect(perms.has("infra:admin")).toBe(false);
    expect(perms.has("infra:dns")).toBe(false);
  });

  it("is idempotent: re-seeding does not duplicate roles or widen admin", async () => {
    const repo = new MemIdentityRepo();
    await seedReferenceData(makeDeps(repo), ORG_ID);
    const before = (await repo.getRoleByName(ORG_ID, "admin"))!;
    await seedReferenceData(makeDeps(repo), ORG_ID);
    const after = (await repo.getRoleByName(ORG_ID, "admin"))!;

    expect(after.id).toBe(before.id);
    expect([...after.permissions].sort()).toEqual([...before.permissions].sort());
  });
});
