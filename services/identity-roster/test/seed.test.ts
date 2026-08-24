import { describe, it, expect } from "vitest";
import { identity, appRegistry } from "@dub/types";
import { MemIdentityRepo } from "../src/repo/mem-repo";
import { seedReferenceData, backfillAppAccessKeys, backfillChatDelete, computeAppAccessKeys } from "../src/seed";
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

describe("per-app access backfill (non-breaking rollout)", () => {
  it("computeAppAccessKeys grants view for reachable apps + edit for writable ones", () => {
    // a member-ish bundle: can read/write tasks, read events, chat, usage
    const keys = new Set(computeAppAccessKeys(["task:read", "task:write", "event:read", "chat:create", "usage:view"]));
    expect(keys.has("app:tasks:view")).toBe(true);
    expect(keys.has("app:tasks:edit")).toBe(true); // has task:write
    expect(keys.has("app:gantt:view")).toBe(true); // gantt rides task:read — now its OWN key
    expect(keys.has("app:gantt:edit")).toBe(true);
    expect(keys.has("app:events:view")).toBe(true);
    expect(keys.has("app:events:edit")).toBe(false); // no event:write
    expect(keys.has("app:usage:view")).toBe(true); // open to all
    // apps it cannot reach today stay OFF
    expect(keys.has("app:mail:view")).toBe(false);
    expect(keys.has("app:admin:view")).toBe(false);
    // open-to-all apps grant view even without the domain perm
    expect(keys.has("app:participation:view")).toBe(true);
    expect(keys.has("app:driveshare:view")).toBe(true);
  });

  it("seeded system roles already carry their per-app keys (member can reach gantt individually)", async () => {
    const repo = new MemIdentityRepo();
    await seedReferenceData(makeDeps(repo), ORG_ID);
    const member = new Set((await repo.getRoleByName(ORG_ID, "member"))!.permissions);
    expect(member.has("app:gantt:view")).toBe(true);
    expect(member.has("app:tasks:view")).toBe(true);
    expect(member.has("app:mail:view")).toBe(false); // member can't read mail today
    const admin = new Set((await repo.getRoleByName(ORG_ID, "admin"))!.permissions);
    for (const k of appRegistry.allAppAccessKeys()) expect(admin.has(k)).toBe(true);
  });

  it("backfill adds missing per-app keys to a PRE-EXISTING role without dropping anything (idempotent)", async () => {
    const repo = new MemIdentityRepo();
    // simulate a legacy role created before the per-app tier: domain perms only
    await repo.createOrg({ id: ORG_ID, name: "DevHub", createdAt: "t" });
    await repo.createRole({
      id: "role_legacy",
      orgId: ORG_ID,
      name: "legacy-ops",
      isSystem: false,
      permissions: ["task:read", "task:write", "mail:read"],
      createdAt: "t",
      updatedAt: "t",
    });
    const updated = await backfillAppAccessKeys(makeDeps(repo), ORG_ID);
    expect(updated).toContain("legacy-ops");
    const perms = new Set((await repo.getRole("role_legacy"))!.permissions);
    // original domain perms preserved
    expect(perms.has("task:read")).toBe(true);
    expect(perms.has("mail:read")).toBe(true);
    // per-app keys added for what it could already do
    expect(perms.has("app:tasks:view")).toBe(true);
    expect(perms.has("app:tasks:edit")).toBe(true);
    expect(perms.has("app:gantt:view")).toBe(true);
    expect(perms.has("app:mail:view")).toBe(true);
    expect(perms.has("app:mail:edit")).toBe(false); // no mail:send
    // second run is a no-op
    const again = await backfillAppAccessKeys(makeDeps(repo), ORG_ID);
    expect(again).not.toContain("legacy-ops");
  });
});

describe("chat:delete backfill (own-message delete gate rollout)", () => {
  it("seeded system roles carry chat:delete (member/organizer/maintainer/admin)", async () => {
    const repo = new MemIdentityRepo();
    await seedReferenceData(makeDeps(repo), ORG_ID);
    for (const name of ["admin", "maintainer", "organizer", "member"]) {
      const perms = new Set((await repo.getRoleByName(ORG_ID, name))!.permissions);
      expect(perms.has("chat:delete"), `${name} should hold chat:delete`).toBe(true);
    }
  });

  it("grants chat:delete to a PRE-EXISTING chat-capable role, skips non-chat roles, idempotent", async () => {
    const repo = new MemIdentityRepo();
    await repo.createOrg({ id: ORG_ID, name: "DevHub", createdAt: "t" });
    // legacy chat-capable role (has chat:create) — created before the gate
    await repo.createRole({ id: "role_chat", orgId: ORG_ID, name: "legacy-chat", isSystem: false, permissions: ["chat:create"], createdAt: "t", updatedAt: "t" });
    // a role that cannot reach chat — must NOT get chat:delete
    await repo.createRole({ id: "role_nochat", orgId: ORG_ID, name: "no-chat", isSystem: false, permissions: ["task:read"], createdAt: "t", updatedAt: "t" });

    const updated = await backfillChatDelete(makeDeps(repo), ORG_ID);
    expect(updated).toContain("legacy-chat");
    expect(updated).not.toContain("no-chat");
    expect(new Set((await repo.getRole("role_chat"))!.permissions).has("chat:delete")).toBe(true);
    expect(new Set((await repo.getRole("role_nochat"))!.permissions).has("chat:delete")).toBe(false);

    // idempotent
    expect(await backfillChatDelete(makeDeps(repo), ORG_ID)).not.toContain("legacy-chat");
  });
});
