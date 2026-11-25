// The hourly follow of role membership (MeetingSyncDO alarm): additive, Gmail only, cheap when
// nothing changed, and resumable.
import { describe, it, expect } from "vitest";
import { errors } from "@dub/errors";
import { createMockDriveShareClient } from "../src/mock-client";
import type { DriveShareClient } from "../src/drive-client";
import { staticMemberDirectory, type MemberGoogleInfo } from "../src/member-directory";
import { buildRoleGrants, fakeRoster } from "./helpers";

const FILE = "fld_designs"; // owner only
const OTHER = "fld_banners"; // owner only
const OPTS = { budgetMs: 60_000, maxWrites: 35 };

const gmailOf = (...logins: string[]): Record<string, MemberGoogleInfo> =>
  Object.fromEntries(logins.map((l) => [`usr:${l}@dub.jp`, { gmail: `${l}@gmail.com`, name: l }]));
const logins = (...names: string[]) => names.map((n) => `${n}@dub.jp`);

function counting(inner: DriveShareClient) {
  const calls = { list: 0, create: 0, remove: 0 };
  const created: string[] = [];
  const client: DriveShareClient = {
    listFiles: (p) => inner.listFiles(p),
    listPermissions: (id) => {
      calls.list++;
      return inner.listPermissions(id);
    },
    createPermission: async (f, p) => {
      calls.create++;
      created.push(p.emailAddress ?? "");
      return inner.createPermission(f, p);
    },
    updatePermission: (f, id, r) => inner.updatePermission(f, id, r),
    deletePermission: async (f, id) => {
      calls.remove++;
      return inner.deletePermission(f, id);
    },
  };
  return { client, calls, created };
}

async function emails(drive: DriveShareClient, file: string): Promise<string[]> {
  return (await drive.listPermissions(file)).permissions.filter((p) => p.role !== "owner").map((p) => p.emailAddress!).sort();
}

describe("syncMembers", () => {
  it("shares with a member who joined the role, on every file the role is granted", async () => {
    const inner = createMockDriveShareClient();
    const role: Record<string, string[]> = { role_a: logins("a") };
    const directory = staticMemberDirectory(gmailOf("a", "b"));
    const { service } = buildRoleGrants({ drive: inner, roster: fakeRoster(role), directory });
    await service.apply(FILE, "usr_admin", "role_a", "writer");
    await service.apply(OTHER, "usr_admin", "role_a", "reader");

    role.role_a = logins("a", "b");
    const r = await service.syncMembers(OPTS);

    expect(r).toMatchObject({ grants: 2, touched: 2, shared: 2, skipped: 0, resume: null });
    expect(await emails(inner, FILE)).toEqual(["a@gmail.com", "b@gmail.com"]);
    const onOther = (await inner.listPermissions(OTHER)).permissions.find((p) => p.emailAddress === "b@gmail.com");
    expect(onOther?.role).toBe("reader"); // each file keeps its grant's role
  });

  it("costs no Drive call when nobody joined", async () => {
    const spy = counting(createMockDriveShareClient());
    const roster = fakeRoster({ role_a: logins("a") });
    const { service } = buildRoleGrants({ drive: spy.client, roster, directory: staticMemberDirectory(gmailOf("a")) });
    await service.apply(FILE, "usr_admin", "role_a", "writer");
    spy.calls.list = 0;

    const r = await service.syncMembers(OPTS);

    expect(r).toMatchObject({ touched: 0, shared: 0 });
    expect(spy.calls.list).toBe(0);
  });

  it("never tries a member without a 名簿 Gmail — that could mail an invite nobody asked for", async () => {
    const spy = counting(createMockDriveShareClient());
    const role: Record<string, string[]> = { role_a: logins("a") };
    const { service } = buildRoleGrants({ drive: spy.client, roster: fakeRoster(role), directory: staticMemberDirectory(gmailOf("a")) });
    await service.apply(FILE, "usr_admin", "role_a", "writer");
    spy.created.length = 0;

    role.role_a = logins("a", "nogmail");
    await service.syncMembers(OPTS);

    expect(spy.created).toEqual([]);
  });

  it("shares with nobody when member-service is down (no Gmail known for anyone)", async () => {
    const spy = counting(createMockDriveShareClient());
    const role: Record<string, string[]> = { role_a: logins("a") };
    const first = buildRoleGrants({ drive: spy.client, roster: fakeRoster(role), directory: staticMemberDirectory(gmailOf("a")) });
    await first.service.apply(FILE, "usr_admin", "role_a", "writer");
    spy.created.length = 0;

    role.role_a = logins("a", "b");
    const down = buildRoleGrants({ drive: spy.client, roster: fakeRoster(role), directory: staticMemberDirectory(), store: first.store });
    await down.service.syncMembers(OPTS);

    expect(spy.created).toEqual([]);
  });

  it("never removes access: a member who left stays until 再適用", async () => {
    const spy = counting(createMockDriveShareClient());
    const role: Record<string, string[]> = { role_a: logins("a", "b") };
    const { service } = buildRoleGrants({ drive: spy.client, roster: fakeRoster(role), directory: staticMemberDirectory(gmailOf("a", "b", "c")) });
    await service.apply(FILE, "usr_admin", "role_a", "writer");

    role.role_a = logins("a", "c"); // b left, c joined
    await service.syncMembers(OPTS);

    expect(spy.calls.remove).toBe(0);
    expect(await emails(spy.client, FILE)).toEqual(["a@gmail.com", "b@gmail.com", "c@gmail.com"]);
  });

  it("stops at its budget and finishes from where it stopped, past a member Drive keeps refusing", async () => {
    const inner = createMockDriveShareClient();
    const drive: DriveShareClient = {
      ...inner,
      listFiles: (p) => inner.listFiles(p),
      listPermissions: (id) => inner.listPermissions(id),
      updatePermission: (f, id, r) => inner.updatePermission(f, id, r),
      deletePermission: (f, id) => inner.deletePermission(f, id),
      createPermission: async (f, p) => {
        if (p.emailAddress === "a@gmail.com") throw errors.forbidden("拒否");
        return inner.createPermission(f, p);
      },
    };
    const names = ["a", "b", "c", "d", "e"];
    const role: Record<string, string[]> = { role_a: [] };
    const { service } = buildRoleGrants({ drive, roster: fakeRoster(role), directory: staticMemberDirectory(gmailOf(...names)) });
    await service.apply(FILE, "usr_admin", "role_a", "writer");
    role.role_a = logins(...names);

    const opts = { budgetMs: 60_000, maxWrites: 2 };
    const first = await service.syncMembers(opts);
    expect(first).toMatchObject({ shared: 1, skipped: 1, resume: { cursor: "b@gmail.com" } });

    const second = await service.syncMembers({ ...opts, resume: first.resume! });
    expect(second).toMatchObject({ shared: 2, resume: { cursor: "d@gmail.com" } });

    const third = await service.syncMembers({ ...opts, resume: second.resume! });
    expect(third).toMatchObject({ shared: 1, resume: null });
    expect(await emails(inner, FILE)).toEqual(["b@gmail.com", "c@gmail.com", "d@gmail.com", "e@gmail.com"]);
  });

  it("restarts cleanly when the grant it was resuming has been removed", async () => {
    const inner = createMockDriveShareClient();
    const { service } = buildRoleGrants({ drive: inner, roster: fakeRoster({ role_a: logins("a") }), directory: staticMemberDirectory(gmailOf("a")) });
    await service.apply(FILE, "usr_admin", "role_a", "writer");
    const r = await service.syncMembers({ ...OPTS, resume: { grantId: "dsg_gone", cursor: "z@gmail.com" } });
    expect(r).toMatchObject({ grants: 1, resume: null });
  });
});

describe("the alarm is armed by the first grant", () => {
  it("kicks after a role is granted, and a failing kick does not fail the grant", async () => {
    let kicks = 0;
    const roster = fakeRoster({ role_a: [] });
    const ok = buildRoleGrants({ drive: createMockDriveShareClient(), roster, kick: async () => void kicks++ });
    await ok.service.apply(FILE, "usr_admin", "role_a", "reader");
    expect(kicks).toBe(1);

    const bad = buildRoleGrants({ drive: createMockDriveShareClient(), roster, kick: () => Promise.reject(new Error("do down")) });
    await expect(bad.service.apply(FILE, "usr_admin", "role_a", "reader")).resolves.toBeDefined();
  });
});
