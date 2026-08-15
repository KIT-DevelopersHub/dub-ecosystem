// Fan-out correctness: NON-DESTRUCTIVE + idempotent role-based Drive sharing.
// Everything runs against the in-memory mock Drive client + a fake roster + the
// in-memory grant store, so the exact same code paths that run on the real Drive client
// are exercised with zero network.
import { describe, it, expect } from "vitest";
import { createMockDriveShareClient } from "../src/mock-client";
import type { DriveShareClient, CreatePermissionParams, ListFilesParams } from "../src/drive-client";
import { createInMemoryRoleGrantStore } from "../src/role-grants-store";
import { buildRoleGrants, fakeRoster } from "./helpers";
import type { SharePermission, ShareRole } from "../src/types";

/** Wrap a Drive client to record create/update/delete calls for assertions. */
function spyClient(inner: DriveShareClient) {
  const createdEmails: string[] = [];
  const deletedIds: string[] = [];
  const updated: Array<{ id: string; role: ShareRole }> = [];
  const client: DriveShareClient = {
    listFiles: (p: ListFilesParams) => inner.listFiles(p),
    listPermissions: (fileId: string) => inner.listPermissions(fileId),
    async createPermission(fileId: string, p: CreatePermissionParams) {
      const r = await inner.createPermission(fileId, p);
      if (p.emailAddress) createdEmails.push(p.emailAddress);
      return r;
    },
    async updatePermission(fileId: string, id: string, role: ShareRole) {
      updated.push({ id, role });
      return inner.updatePermission(fileId, id, role);
    },
    async deletePermission(fileId: string, id: string) {
      deletedIds.push(id);
      return inner.deletePermission(fileId, id);
    },
  };
  return { client, createdEmails, deletedIds, updated };
}

async function permOf(client: DriveShareClient, fileId: string, email: string): Promise<SharePermission | undefined> {
  const { permissions } = await client.listPermissions(fileId);
  return permissions.find((p) => p.emailAddress === email);
}

const FILE = "fld_designs"; // seeded with only the owner permission → clean slate

describe("apply (grant): creates for members, respects pre-existing", () => {
  it("creates our permissions and never touches a pre-existing individual share", async () => {
    const spy = spyClient(createMockDriveShareClient());
    // fil_budget already has sponsor@example.com as reader (an individual share).
    const roster = fakeRoster({ role_a: ["sponsor@example.com", "volunteer@example.com"] });
    const { service, store } = buildRoleGrants({ drive: spy.client, roster });

    const grant = await service.apply("fil_budget", "usr_admin", "role_a", "writer");

    expect(grant.memberCount).toBe(2);
    expect(grant.appliedCount).toBe(2);
    // pre-existing sponsor stays reader (NOT upgraded to writer) and was not created by us.
    expect((await permOf(spy.client, "fil_budget", "sponsor@example.com"))!.role).toBe("reader");
    // volunteer got a fresh writer permission that we created.
    expect((await permOf(spy.client, "fil_budget", "volunteer@example.com"))!.role).toBe("writer");
    expect(spy.createdEmails).toEqual(["volunteer@example.com"]);

    const members = await store.listMembers(grant.id);
    expect(members.find((m) => m.email === "sponsor@example.com")!.createdByUs).toBe(0);
    expect(members.find((m) => m.email === "volunteer@example.com")!.createdByUs).toBe(1);
  });
});

describe("upsert: changes driveRole for our members, leaves pre-existing alone", () => {
  it("re-applies with a new driveRole and updates only our permission", async () => {
    const spy = spyClient(createMockDriveShareClient());
    const roster = fakeRoster({ role_a: ["sponsor@example.com", "volunteer@example.com"] });
    const { service } = buildRoleGrants({ drive: spy.client, roster });

    await service.apply("fil_budget", "usr_admin", "role_a", "writer");
    const grant2 = await service.apply("fil_budget", "usr_admin", "role_a", "commenter");

    expect(grant2.driveRole).toBe("commenter");
    // our volunteer permission is now commenter; sponsor (individual) still reader.
    expect((await permOf(spy.client, "fil_budget", "volunteer@example.com"))!.role).toBe("commenter");
    expect((await permOf(spy.client, "fil_budget", "sponsor@example.com"))!.role).toBe("reader");
  });
});

describe("idempotency: double grant = no duplicate permission", () => {
  it("applying the same grant twice creates the member permission only once", async () => {
    const spy = spyClient(createMockDriveShareClient());
    const roster = fakeRoster({ role_a: ["a@example.com", "b@example.com"] });
    const { service, store } = buildRoleGrants({ drive: spy.client, roster });

    const g1 = await service.apply(FILE, "usr_admin", "role_a", "reader");
    await service.apply(FILE, "usr_admin", "role_a", "reader");

    expect(spy.createdEmails.sort()).toEqual(["a@example.com", "b@example.com"]); // only the first pass created
    const { permissions } = await spy.client.listPermissions(FILE);
    expect(permissions.filter((p) => p.emailAddress === "a@example.com")).toHaveLength(1);
    expect((await store.listGrants((await store.getGrant("org_devhub", FILE, "role_a"))!.orgId)).filter((x) => x.id === g1.id)).toHaveLength(1);
  });
});

describe("revoke: removes only our permissions", () => {
  it("deletes permissions we created but keeps pre-existing individual shares, then drops rows", async () => {
    const spy = spyClient(createMockDriveShareClient());
    const roster = fakeRoster({ role_a: ["sponsor@example.com", "volunteer@example.com"] });
    const { service, store } = buildRoleGrants({ drive: spy.client, roster });

    await service.apply("fil_budget", "usr_admin", "role_a", "writer");
    const ourPerm = await permOf(spy.client, "fil_budget", "volunteer@example.com");

    await service.revoke("fil_budget", "role_a");

    // our volunteer permission deleted; sponsor's individual share survives.
    expect(await permOf(spy.client, "fil_budget", "volunteer@example.com")).toBeUndefined();
    expect(await permOf(spy.client, "fil_budget", "sponsor@example.com")).toBeDefined();
    expect(spy.deletedIds).toEqual([ourPerm!.id]);
    expect(await store.getGrant("org_devhub", "fil_budget", "role_a")).toBeNull();
  });

  it("is idempotent (revoking a non-existent grant is a no-op)", async () => {
    const spy = spyClient(createMockDriveShareClient());
    const { service } = buildRoleGrants({ drive: spy.client, roster: fakeRoster({}) });
    await expect(service.revoke(FILE, "role_missing")).resolves.toBeUndefined();
    expect(spy.deletedIds).toEqual([]);
  });

  it("keeps a permission still referenced by another grant with created_by_us=1", async () => {
    const spy = spyClient(createMockDriveShareClient());
    const store = createInMemoryRoleGrantStore();
    const { service } = buildRoleGrants({ drive: spy.client, roster: fakeRoster({}), store });

    // Two grants on the same file both claim to have created shared@'s permission.
    const shared = await spy.client.createPermission(FILE, { type: "user", role: "reader", emailAddress: "shared@example.com" });
    const gX = await store.upsertGrant({ id: "gX", orgId: "org_devhub", fileId: FILE, roleId: "role_x", driveRole: "reader", grantedBy: "u", grantedAt: "t", updatedAt: "t" });
    const gY = await store.upsertGrant({ id: "gY", orgId: "org_devhub", fileId: FILE, roleId: "role_y", driveRole: "reader", grantedBy: "u", grantedAt: "t", updatedAt: "t" });
    await store.replaceMembers(gX.id, [{ grantId: gX.id, email: "shared@example.com", permissionId: shared.id, createdByUs: 1 }]);
    await store.replaceMembers(gY.id, [{ grantId: gY.id, email: "shared@example.com", permissionId: shared.id, createdByUs: 1 }]);

    await service.revoke(FILE, "role_x");

    // guard: role_y still holds shared@ (created_by_us=1) → permission is kept.
    expect(spy.deletedIds).toEqual([]);
    expect(await permOf(spy.client, FILE, "shared@example.com")).toBeDefined();
  });
});

describe("reapply (reconcile): adds new members, removes departed", () => {
  it("creates newly-added members and deletes departed members' permissions", async () => {
    const spy = spyClient(createMockDriveShareClient());
    const members: Record<string, string[]> = { role_a: ["a@example.com", "b@example.com"] };
    const roster = fakeRoster(members);
    const { service } = buildRoleGrants({ drive: spy.client, roster });

    await service.apply(FILE, "usr_admin", "role_a", "reader");
    const aPerm = await permOf(spy.client, FILE, "a@example.com");

    // membership changes: a departs, c joins, b stays.
    members.role_a = ["b@example.com", "c@example.com"];
    const grant = await service.reapply(FILE, "role_a");

    expect(grant.memberCount).toBe(2);
    expect(grant.appliedCount).toBe(2);
    expect(await permOf(spy.client, FILE, "a@example.com")).toBeUndefined(); // departed → deleted
    expect(await permOf(spy.client, FILE, "b@example.com")).toBeDefined(); // stayed
    expect(await permOf(spy.client, FILE, "c@example.com")).toBeDefined(); // new
    expect(spy.deletedIds).toEqual([aPerm!.id]);
  });

  it("404s when reapplying a grant that does not exist", async () => {
    const spy = spyClient(createMockDriveShareClient());
    const { service } = buildRoleGrants({ drive: spy.client, roster: fakeRoster({}) });
    await expect(service.reapply(FILE, "role_missing")).rejects.toMatchObject({ code: expect.stringContaining("NOT_FOUND") });
  });
});

describe("validation", () => {
  it("rejects a non-assignable driveRole", async () => {
    const spy = spyClient(createMockDriveShareClient());
    const { service } = buildRoleGrants({ drive: spy.client, roster: fakeRoster({ role_a: [] }) });
    await expect(service.apply(FILE, "u", "role_a", "owner" as "reader")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects an empty roleId", async () => {
    const spy = spyClient(createMockDriveShareClient());
    const { service } = buildRoleGrants({ drive: spy.client, roster: fakeRoster({}) });
    await expect(service.apply(FILE, "u", "  ", "reader")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
