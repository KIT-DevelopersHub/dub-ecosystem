// A role's fan-out can outlast api-gateway's 15 s: one call stops at its budget and hands back
// a cursor, and the ledger survives a request killed mid-way.
import { describe, it, expect } from "vitest";
import { createMockDriveShareClient } from "../src/mock-client";
import type { DriveShareClient } from "../src/drive-client";
import { createDbClient } from "@dub/db";
import { createD1RoleGrantStore } from "../src/role-grants-store";
import { buildRoleGrants, fakeRoster } from "./helpers";

const FILE = "fld_designs"; // owner only
const members = (n: number) => Array.from({ length: n }, (_, i) => `m${String(i).padStart(2, "0")}@gmail.com`);

/** Every Drive write takes `ms` of the fake clock. */
function slowDrive(inner: DriveShareClient, tick: { now: number }, ms: number): DriveShareClient {
  return {
    ...inner,
    listFiles: (p) => inner.listFiles(p),
    listPermissions: (id) => inner.listPermissions(id),
    updatePermission: (f, id, r) => inner.updatePermission(f, id, r),
    deletePermission: async (f, id) => {
      tick.now += ms;
      return inner.deletePermission(f, id);
    },
    createPermission: async (f, p) => {
      tick.now += ms;
      return inner.createPermission(f, p);
    },
  };
}

async function emailsOn(drive: DriveShareClient): Promise<string[]> {
  return (await drive.listPermissions(FILE)).permissions.filter((p) => p.role !== "owner").map((p) => p.emailAddress!);
}

describe("per-call budget", () => {
  it("stops at the time budget and finishes through the cursor without redoing anyone", async () => {
    const tick = { now: 0 };
    const inner = createMockDriveShareClient();
    const drive = slowDrive(inner, tick, 2_000);
    const { service } = buildRoleGrants({ drive, roster: fakeRoster({ role_a: members(10) }), clock: () => tick.now });

    const first = await service.apply(FILE, "usr_admin", "role_a", "reader");
    expect(first.nextCursor).toBe("m03@gmail.com"); // 4 writes = 8 s
    expect(first.remaining).toBe(6);
    expect(first.appliedCount).toBe(4);
    expect(tick.now).toBeLessThan(15_000);

    let res = first;
    let calls = 1;
    while (res.nextCursor !== undefined) {
      res = await service.reapply(FILE, "role_a", res.nextCursor);
      calls++;
    }
    expect(calls).toBe(3);
    expect(res.appliedCount).toBe(10);
    expect(res.remaining).toBeUndefined();
    expect((await emailsOn(inner)).sort()).toEqual(members(10));
  });

  it("caps the writes of one call so a fast Drive stays inside the subrequest limit", async () => {
    const { service } = buildRoleGrants({ drive: createMockDriveShareClient(), roster: fakeRoster({ role_a: members(30) }), clock: () => 0 });
    const first = await service.apply(FILE, "usr_admin", "role_a", "reader");
    expect(first.appliedCount).toBe(25);
    expect(first.remaining).toBe(5);
  });

  it("removes departed members last, continuing through the cursor if the budget ran out", async () => {
    const tick = { now: 0 };
    const inner = createMockDriveShareClient();
    const drive = slowDrive(inner, tick, 3_000);
    const role: Record<string, string[]> = { role_a: members(5) };
    const { service } = buildRoleGrants({ drive, roster: fakeRoster(role), clock: () => tick.now });
    let res = await service.apply(FILE, "usr_admin", "role_a", "reader");
    while (res.nextCursor !== undefined) res = await service.reapply(FILE, "role_a", res.nextCursor);

    role.role_a = ["m00@gmail.com"]; // four departed: 3 s each, so more than one call
    res = await service.reapply(FILE, "role_a");
    expect(res.nextCursor).toBeDefined();
    while (res.nextCursor !== undefined) res = await service.reapply(FILE, "role_a", res.nextCursor);
    expect(await emailsOn(inner)).toEqual(["m00@gmail.com"]);
    expect(res.appliedCount).toBe(1);
  });
});

describe("a request killed mid-way (gateway 504 cancels the Worker)", () => {
  /** Drive creates the permission, then the Worker dies before anything after it runs. */
  function dyingAfter(inner: DriveShareClient, okCreates: number): DriveShareClient {
    let n = 0;
    return {
      ...inner,
      listFiles: (p) => inner.listFiles(p),
      listPermissions: (id) => inner.listPermissions(id),
      updatePermission: (f, id, r) => inner.updatePermission(f, id, r),
      deletePermission: (f, id) => inner.deletePermission(f, id),
      createPermission: async (f, p) => {
        const perm = await inner.createPermission(f, p);
        if (++n > okCreates) await new Promise<never>(() => {}); // never resumes, like a cancelled isolate
        return perm;
      },
    };
  }

  it("keeps ownership of what it created, so 解除 still removes those shares", async () => {
    const inner = createMockDriveShareClient();
    const roster = fakeRoster({ role_a: ["a@gmail.com", "b@gmail.com"] });
    const store = buildRoleGrants({ drive: inner, roster }).store;

    // Dies inside the create for b@ (a@ fully recorded).
    const dying = buildRoleGrants({ drive: dyingAfter(inner, 1), roster, store }).service;
    void dying.apply(FILE, "usr_admin", "role_a", "reader");
    await new Promise((r) => setTimeout(r, 10));
    expect((await emailsOn(inner)).sort()).toEqual(["a@gmail.com", "b@gmail.com"]);

    const { service } = buildRoleGrants({ drive: inner, roster, store });
    const after = await service.reapply(FILE, "role_a");
    expect(after.appliedCount).toBe(2);

    await service.revoke(FILE, "role_a");
    expect(await emailsOn(inner)).toEqual([]); // nothing stranded as an "individual" share
  });
});

// The in-memory store never meets the @dub/db namespace guard: run the real statements past it.
describe("D1 ledger statements", () => {
  it("pass the namespace guard", async () => {
    const sql: string[] = [];
    const stmt = (q: string) => {
      const self = {
        bind: () => self,
        run: async () => (sql.push(q), { success: true, meta: { changes: 1 } }),
        all: async () => ({ results: [] }),
        first: async () => null,
      };
      return self;
    };
    const store = createD1RoleGrantStore(createDbClient({ prepare: stmt } as never, { namespace: "driveshare", requestId: "t" }));
    await store.upsertMember({ grantId: "g", email: "a@gmail.com", permissionId: null, createdByUs: 1 });
    await store.deleteMember("g", "a@gmail.com");
    expect(sql).toHaveLength(2);
  });
});
