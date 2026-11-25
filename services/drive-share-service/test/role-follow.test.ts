// Role follow: a role's Drive共有 grants and ミーティング invitations reach people who join the role
// later and leave people who leave it — idempotent, upcoming meetings only, removals guarded — plus
// the one-off backfill (dry-run by default). Google is the in-memory mock throughout.
import { describe, it, expect } from "vitest";
import { errors } from "@dub/errors";
import { identity } from "@dub/types";
import { createApp } from "../src/app";
import { createDriveShareService } from "../src/service";
import { createMockDriveShareClient } from "../src/mock-client";
import { GoogleQuotaError, type DriveShareClient } from "../src/drive-client";
import { staticMemberDirectory, type MemberDirectory, type MemberGoogleInfo } from "../src/member-directory";
import { createRoleFollowService, parseMembershipMessage, type RoleFollowDeps } from "../src/role-follow";
import type { ActiveUser } from "../src/role-membership";
import type { RoleGrantsService } from "../src/role-grants-service";
import { AUTHED, buildMeetings, buildRoleGrants, fakeRoster, memAuthzHolding, stubGoogleAccount } from "./helpers";

const FILE = "fld_designs"; // owner only
const OTHER = "fld_banners"; // owner only
const NAMES = { role_a: "A班", role_b: "B班" };
const BUDGET = { budgetMs: 60_000, maxWrites: 35 };

const gmailOf = (...logins: string[]): Record<string, MemberGoogleInfo> =>
  Object.fromEntries(logins.map((l) => [`usr:${l}@dub.jp`, { gmail: `${l}@gmail.com`, name: l }]));
const logins = (...names: string[]) => names.map((n) => `${n}@dub.jp`);

function counting(inner: DriveShareClient, fail?: (email: string) => Error | null) {
  const calls = { list: 0, create: 0, remove: 0 };
  const client: DriveShareClient = {
    listFiles: (p) => inner.listFiles(p),
    listPermissions: (id) => {
      calls.list++;
      return inner.listPermissions(id);
    },
    createPermission: async (f, p) => {
      calls.create++;
      const err = fail?.(p.emailAddress ?? "");
      if (err) throw err;
      return inner.createPermission(f, p);
    },
    updatePermission: (f, id, r) => inner.updatePermission(f, id, r),
    deletePermission: async (f, id) => {
      calls.remove++;
      return inner.deletePermission(f, id);
    },
  };
  return { client, calls };
}

async function emails(drive: DriveShareClient, file: string): Promise<string[]> {
  return (await drive.listPermissions(file)).permissions.filter((p) => p.role !== "owner").map((p) => p.emailAddress!).sort();
}

function setup(opts: { members: Record<string, string[]>; gmail: string[]; names?: Record<string, string>; fail?: (email: string) => Error | null; directory?: MemberDirectory }) {
  const inner = createMockDriveShareClient();
  const spy = counting(inner, opts.fail);
  const roster = fakeRoster(opts.members, opts.names ?? NAMES);
  const { service, store } = buildRoleGrants({ drive: spy.client, roster, directory: opts.directory ?? staticMemberDirectory(gmailOf(...opts.gmail)), strictDirectory: true });
  return { inner, spy, service, store, members: opts.members };
}

describe("followRoles: joining", () => {
  it("shares every file of the role with the late joiner, at their 名簿 Gmail, with each grant's role", async () => {
    const t = setup({ members: { role_a: logins("a") }, gmail: ["a", "b"] });
    await t.service.apply(FILE, "usr_admin", "role_a", "writer");
    await t.service.apply(OTHER, "usr_admin", "role_a", "reader");

    t.members.role_a = logins("a", "b"); // b joins later
    const r = await t.service.followRoles(["role_a"], "added", BUDGET);

    expect(r).toMatchObject({ grants: 2, shared: 2, revoked: 0, complete: true });
    expect(await emails(t.inner, FILE)).toEqual(["a@gmail.com", "b@gmail.com"]);
    const onOther = (await t.inner.listPermissions(OTHER)).permissions.find((p) => p.emailAddress === "b@gmail.com");
    expect(onOther?.role).toBe("reader");
  });

  it("is idempotent: a redelivered message creates nothing (no duplicate permission)", async () => {
    const t = setup({ members: { role_a: logins("a") }, gmail: ["a", "b"] });
    await t.service.apply(FILE, "usr_admin", "role_a", "writer");
    t.members.role_a = logins("a", "b");
    await t.service.followRoles(["role_a"], "added", BUDGET);
    t.spy.calls.create = 0;

    const again = await t.service.followRoles(["role_a"], "added", BUDGET);

    expect(again).toMatchObject({ shared: 0, skipped: [] });
    expect(t.spy.calls.create).toBe(0);
    expect(await emails(t.inner, FILE)).toEqual(["a@gmail.com", "b@gmail.com"]);
  });

  it("a member already shared by hand is recorded, never re-shared or modified", async () => {
    const t = setup({ members: { role_a: logins("a") }, gmail: ["a", "b"] });
    await t.service.apply(FILE, "usr_admin", "role_a", "writer");
    await t.inner.createPermission(FILE, { type: "user", role: "commenter", emailAddress: "b@gmail.com" });
    t.members.role_a = logins("a", "b");
    t.spy.calls.create = 0;

    await t.service.followRoles(["role_a"], "added", BUDGET);

    expect(t.spy.calls.create).toBe(0);
    const b = (await t.inner.listPermissions(FILE)).permissions.find((p) => p.emailAddress === "b@gmail.com");
    expect(b?.role).toBe("commenter");
  });

  it("only touches the grants of the roles in the message", async () => {
    const t = setup({ members: { role_a: logins("a"), role_b: logins("x") }, gmail: ["a", "b", "x", "y"] });
    await t.service.apply(FILE, "usr_admin", "role_a", "writer");
    await t.service.apply(OTHER, "usr_admin", "role_b", "reader");
    t.members.role_a = logins("a", "b");
    t.members.role_b = logins("x", "y");
    t.spy.calls.list = 0;

    const r = await t.service.followRoles(["role_a"], "added", BUDGET);

    expect(r.grants).toBe(1);
    expect(t.spy.calls.list).toBe(1);
    expect(await emails(t.inner, OTHER)).toEqual(["x@gmail.com"]);
  });

  it("an address Google refuses is reported, not retried; a limit / outage throws so the outbox retries", async () => {
    const refused = setup({ members: { role_a: [] }, gmail: ["a", "b"], fail: (e) => (e === "a@gmail.com" ? errors.forbidden("拒否") : null) });
    await refused.service.apply(FILE, "usr_admin", "role_a", "writer");
    refused.members.role_a = logins("a", "b");
    const r = await refused.service.followRoles(["role_a"], "added", BUDGET);
    expect(r).toMatchObject({ shared: 1, complete: true });
    expect(r.skipped.map((s) => s.email)).toEqual(["a@gmail.com"]);

    const limited = setup({ members: { role_a: [] }, gmail: ["a"], fail: () => new GoogleQuotaError("drive", "rateLimitExceeded") });
    await limited.service.apply(FILE, "usr_admin", "role_a", "writer");
    limited.members.role_a = logins("a");
    await expect(limited.service.followRoles(["role_a"], "added", BUDGET)).rejects.toBeInstanceOf(GoogleQuotaError);
    // The ledger row written ahead of the failed call was rolled back: the retry shares it.
    expect(await limited.store.listMembers((await limited.store.listGrants("org_devhub"))[0]!.id)).toEqual([]);

    const down = setup({ members: { role_a: [] }, gmail: ["a"], fail: () => errors.upstreamUnavailable("google") });
    await down.service.apply(FILE, "usr_admin", "role_a", "writer");
    down.members.role_a = logins("a");
    await expect(down.service.followRoles(["role_a"], "added", BUDGET)).rejects.toThrow();
  });

  it("a 名簿 outage throws (retried) instead of reading as 'nobody has a Gmail'", async () => {
    const directory: MemberDirectory = {
      async googleEmails(_ids, opts) {
        if (opts?.strict) throw errors.upstreamUnavailable("member-service");
        return new Map();
      },
    };
    const t = setup({ members: { role_a: [] }, gmail: [], directory });
    await t.store.upsertGrant({ id: "dsg_1", orgId: "org_devhub", fileId: FILE, roleId: "role_a", driveRole: "reader", grantedBy: "u", grantedAt: "t", updatedAt: "t" });
    t.members.role_a = logins("a");
    await expect(t.service.followRoles(["role_a"], "added", BUDGET)).rejects.toThrow();
  });

  it("reports incomplete when the budget runs out (the caller retries; the next call continues)", async () => {
    const t = setup({ members: { role_a: [] }, gmail: ["a", "b", "c"] });
    await t.service.apply(FILE, "usr_admin", "role_a", "writer");
    t.members.role_a = logins("a", "b", "c");
    const first = await t.service.followRoles(["role_a"], "added", { budgetMs: 60_000, maxWrites: 2 });
    expect(first).toMatchObject({ shared: 2, complete: false });
    const second = await t.service.followRoles(["role_a"], "added", { budgetMs: 60_000, maxWrites: 2 });
    expect(second).toMatchObject({ shared: 1, complete: true });
    expect(await emails(t.inner, FILE)).toEqual(["a@gmail.com", "b@gmail.com", "c@gmail.com"]);
  });
});

describe("followRoles: leaving", () => {
  it("deletes the permission Dub created for the member who left — and nothing else", async () => {
    const t = setup({ members: { role_a: logins("a", "b") }, gmail: ["a", "b"] });
    await t.service.apply(FILE, "usr_admin", "role_a", "writer");
    t.members.role_a = logins("a");

    const r = await t.service.followRoles(["role_a"], "removed", BUDGET);

    expect(r).toMatchObject({ revoked: 1, held: 0, complete: true });
    expect(await emails(t.inner, FILE)).toEqual(["a@gmail.com"]);
    // idempotent
    t.spy.calls.remove = 0;
    expect(await t.service.followRoles(["role_a"], "removed", BUDGET)).toMatchObject({ revoked: 0 });
    expect(t.spy.calls.remove).toBe(0);
  });

  it("never deletes a share that existed before the grant (someone shared it by hand)", async () => {
    const t = setup({ members: { role_a: logins("a", "b") }, gmail: ["a", "b"] });
    await t.inner.createPermission(FILE, { type: "user", role: "writer", emailAddress: "b@gmail.com" });
    await t.service.apply(FILE, "usr_admin", "role_a", "writer");
    t.members.role_a = logins("a");

    await t.service.followRoles(["role_a"], "removed", BUDGET);

    expect(await emails(t.inner, FILE)).toEqual(["a@gmail.com", "b@gmail.com"]);
  });

  it("keeps access the member still has through another role granted on the same file", async () => {
    const t = setup({ members: { role_a: logins("a", "b"), role_b: logins("b") }, gmail: ["a", "b"] });
    await t.service.apply(FILE, "usr_admin", "role_a", "writer");
    await t.service.apply(FILE, "usr_admin", "role_b", "reader");
    t.members.role_a = logins("a"); // b leaves A班 but is still in B班

    const r = await t.service.followRoles(["role_a"], "removed", BUDGET);

    expect(r.revoked).toBe(0);
    expect(await emails(t.inner, FILE)).toEqual(["a@gmail.com", "b@gmail.com"]);

    // The permission was handed over to B班's grant: when b leaves B班 as well, it goes.
    t.members.role_b = logins("a");
    expect(await t.service.followRoles(["role_b"], "removed", BUDGET)).toMatchObject({ revoked: 1 });
    expect(await emails(t.inner, FILE)).toEqual(["a@gmail.com"]);
  });

  it("never revokes a member shared at their login address (no Gmail) by a manual 適用", async () => {
    const t = setup({ members: { role_a: logins("a", "nogmail", "b") }, gmail: ["a", "b"] });
    await t.service.apply(FILE, "usr_admin", "role_a", "writer"); // nogmail@dub.jp shared at the login address
    t.members.role_a = logins("a", "nogmail"); // b leaves

    await t.service.followRoles(["role_a"], "removed", BUDGET);

    expect(await emails(t.inner, FILE)).toEqual(["a@gmail.com", "nogmail@dub.jp"]);
  });

  it("holds removals when the role is unknown or reads as empty (a glitch must not unshare everyone)", async () => {
    const gone = setup({ members: { role_x: logins("a") }, gmail: ["a"], names: { role_a: "A班" } });
    await gone.service.apply(FILE, "usr_admin", "role_x", "writer");
    gone.members.role_x = [];
    expect(await gone.service.followRoles(["role_x"], "removed", BUDGET)).toMatchObject({ revoked: 0, held: 1 });
    expect(await emails(gone.inner, FILE)).toEqual(["a@gmail.com"]);

    const empty = setup({ members: { role_a: logins("a") }, gmail: ["a"] });
    await empty.service.apply(FILE, "usr_admin", "role_a", "writer");
    empty.members.role_a = [];
    expect(await empty.service.followRoles(["role_a"], "removed", BUDGET)).toMatchObject({ revoked: 0, held: 1 });
    expect(await emails(empty.inner, FILE)).toEqual(["a@gmail.com"]);
  });

  it("an unreadable role list throws (retried) instead of counting as 'role deleted'", async () => {
    const t = setup({ members: { role_a: logins("a", "b") }, gmail: ["a", "b"], names: {} });
    await t.service.apply(FILE, "usr_admin", "role_a", "writer");
    t.members.role_a = logins("a");
    await expect(t.service.followRoles(["role_a"], "removed", BUDGET)).rejects.toThrow();
    expect(await emails(t.inner, FILE)).toEqual(["a@gmail.com", "b@gmail.com"]);
  });
});

describe("backfill: planReconcile (dry-run) / applyReconcile", () => {
  it("plans from the ledger without any Google call, then applying empties the plan", async () => {
    const t = setup({ members: { role_a: logins("a", "b"), role_x: logins("z") }, gmail: ["a", "b", "c", "z"], names: { role_a: "A班", role_x: "X" } });
    await t.service.apply(FILE, "usr_admin", "role_a", "writer");
    await t.service.apply(OTHER, "usr_admin", "role_x", "reader");
    t.members.role_a = logins("a", "c", "nogmail"); // b left, c joined, nogmail joined without a Gmail
    const planner = buildRoleGrants({ drive: t.spy.client, roster: fakeRoster(t.members, { role_a: "A班" }), directory: staticMemberDirectory(gmailOf("a", "b", "c", "z")), store: t.store, strictDirectory: true });
    t.spy.calls.list = 0;
    t.spy.calls.create = 0;

    const plan = await planner.service.planReconcile();

    expect(t.spy.calls).toEqual({ list: 0, create: 0, remove: 0 }); // dry-run: no Google call
    expect(plan.toShare.map((i) => [i.fileId, i.email, i.driveRole])).toEqual([[FILE, "c@gmail.com", "writer"]]);
    expect(plan.toRevoke.map((i) => [i.fileId, i.email])).toEqual([[FILE, "b@gmail.com"]]);
    expect(plan.orphanGrants.map((g) => g.roleId)).toEqual(["role_x"]); // role deleted: reported, untouched
    expect(plan.withoutGmail).toBe(1);

    const applied = await planner.service.applyReconcile({ budgetMs: 60_000, maxWrites: 25 });
    expect(applied).toMatchObject({ shared: 1, revoked: 1, remaining: 0 });
    expect(await emails(t.inner, FILE)).toEqual(["a@gmail.com", "c@gmail.com"]);
    expect(await emails(t.inner, OTHER)).toEqual(["z@gmail.com"]); // orphan grant left alone

    const after = await planner.service.planReconcile();
    expect(after).toMatchObject({ toShare: [], toRevoke: [] });
  });
});

describe("meetings: plan + followsAnyRole (upcoming only)", () => {
  const USERS: ActiveUser[] = [
    { id: "usr_a", email: "a@dub.example", name: "A", roleIds: ["role_dev"] },
    { id: "usr_b", email: "b@dub.example", name: "B", roleIds: ["role_dev"] },
  ];
  const ONE_OFF = { title: "キックオフ", targetId: "role_dev", startsAt: "2026-10-20T10:00:00.000Z", durationMinutes: 60, recurrence: "none" };
  const WEEKLY = { ...ONE_OFF, title: "開発定例", recurrence: "weekly" };

  it("a late joiner is planned for upcoming / running meetings only, and the sync then invites them", async () => {
    let users = USERS;
    let now = "2026-10-14T00:00:00.000Z";
    const roster = { ...fakeRoster({}, { role_dev: "開発" }, USERS), listActiveUsers: async (roleId?: string) => users.filter((u) => !roleId || u.roleIds.includes(roleId)) };
    const { service, calendar } = buildMeetings({ roster, now: () => now });
    const past = await service.create("usr_admin", ONE_OFF);
    const series = await service.create("usr_admin", WEEKLY);

    now = "2026-11-01T00:00:00.000Z"; // the one-off is over; the weekly series still runs
    users = [
      { id: "usr_a", email: "a@dub.example", name: "A", roleIds: [] }, // a left 開発
      USERS[1]!,
      { id: "usr_c", email: "c@dub.example", name: "C", roleIds: ["role_dev"] }, // c joined
    ];

    expect(await service.followsAnyRole(["role_dev"])).toBe(true);
    expect(await service.followsAnyRole(["role_pr"])).toBe(false);

    const plan = await service.plan();
    expect(plan).toMatchObject({ meetings: 1, skippedPast: 1, removalsHeld: [] });
    expect(plan.toInvite).toEqual([{ meetingId: series.id, title: "開発定例", email: "c@dub.example" }]);
    expect(plan.toUninvite).toEqual([{ meetingId: series.id, title: "開発定例", email: "a@dub.example" }]);
    expect(plan.toInvite.some((i) => i.meetingId === past.id)).toBe(false);

    await service.sync();
    const mock = calendar as unknown as { state: { calendars: Map<string, { events: Map<string, { id: string; summary?: string; attendees: { email: string }[] }> }> } };
    const events = [...[...mock.state.calendars.values()][0]!.events.values()];
    const attendeesOf = (title: string) => events.find((e) => e.summary === title)!.attendees.map((a) => a.email).sort();
    expect(attendeesOf("開発定例")).toEqual(["b@dub.example", "c@dub.example"]);
    expect(attendeesOf("キックオフ")).toEqual(["a@dub.example", "b@dub.example"]); // ended: frozen
    expect(await service.plan()).toMatchObject({ toInvite: [], toUninvite: [] });
  });

  it("syncRoles invites a late joiner right away — only on meetings of that role, never an ended one", async () => {
    let users = USERS;
    let now = "2026-10-14T00:00:00.000Z";
    const roster = { ...fakeRoster({}, { role_dev: "開発", role_pr: "広報" }, USERS), listActiveUsers: async (roleId?: string) => users.filter((u) => !roleId || u.roleIds.includes(roleId)) };
    const { service, calendar } = buildMeetings({ roster, now: () => now });
    await service.create("usr_admin", ONE_OFF);
    await service.create("usr_admin", WEEKLY);
    await service.create("usr_admin", { ...WEEKLY, title: "広報定例", targetId: "role_pr" });

    now = "2026-11-01T00:00:00.000Z";
    users = [...USERS, { id: "usr_c", email: "c@dub.example", name: "C", roleIds: ["role_dev", "role_pr"] }];
    const r = await service.syncRoles(["role_dev"]);

    expect(r).toMatchObject({ meetings: 1, invitedAdded: 1, invitedRemoved: 0, complete: true });
    const mock = calendar as unknown as { state: { calendars: Map<string, { events: Map<string, { summary?: string; attendees: { email: string }[] }> }> } };
    const events = [...mock.state.calendars.values()].flatMap((c) => [...c.events.values()]);
    const attendeesOf = (title: string) => events.find((e) => e.summary === title)!.attendees.map((a) => a.email).sort();
    expect(attendeesOf("開発定例")).toContain("c@dub.example");
    expect(attendeesOf("キックオフ")).not.toContain("c@dub.example"); // ended
    expect(attendeesOf("広報定例")).not.toContain("c@dub.example"); // another role: not this call

    // idempotent
    expect(await service.syncRoles(["role_dev"])).toMatchObject({ invitedAdded: 0, invitedRemoved: 0 });
  });

  it("syncRoles writes nothing while the calendar sync is paused by a usage limit", async () => {
    const syncState = { load: async () => ({ pausedUntil: Date.parse("2099-01-01T00:00:00.000Z"), aclWritesNotBefore: 0, acl: {}, meetingCursor: null }), pause: async () => ({ until: 0, started: false }), save: async () => {} };
    const { service } = buildMeetings({ roster: fakeRoster({}, { role_dev: "開発" }, USERS), now: () => "2026-10-14T00:00:00.000Z", syncState });
    expect(await service.syncRoles(["role_dev"])).toMatchObject({ meetings: 0, skipped: "quota_paused" });
  });

  it("holds planned removals when the role reads as empty", async () => {
    let users = USERS;
    const roster = { ...fakeRoster({}, { role_dev: "開発" }, USERS), listActiveUsers: async () => users };
    const { service } = buildMeetings({ roster, now: () => "2026-10-14T00:00:00.000Z" });
    const m = await service.create("usr_admin", WEEKLY);
    users = [];
    expect(await service.plan()).toMatchObject({ toUninvite: [], removalsHeld: [m.id] });
  });
});

describe("RoleFollowService (synchronous follow + backfill)", () => {
  const msg = (over: Partial<identity.RoleMembershipChangedV1> = {}): identity.RoleMembershipChangedV1 => ({
    type: "identity.role_membership.changed",
    version: 1,
    id: "01J0000000000000000000000",
    occurredAt: "2026-11-24T00:00:00.000Z",
    orgId: "org_devhub",
    userId: "usr_b",
    change: "added",
    roleIds: ["role_a"],
    reason: "assign",
    ...over,
  });

  function follow(opts: { live?: boolean; follows?: boolean; complete?: boolean; fail?: Error; skipped?: { email: string; reason: string }[]; calFail?: Error; calSkipped?: "quota_paused" | "not_ready" } = {}) {
    const kicks: number[] = [];
    const synced: string[] = [];
    const calls: string[] = [];
    const roleGrants = {
      async followRoles(roleIds: readonly string[], change: string) {
        calls.push(`${change}:${roleIds.join(",")}`);
        if (opts.fail) throw opts.fail;
        return { grants: 1, shared: 1, revoked: 0, skipped: opts.skipped ?? [], held: 0, complete: opts.complete ?? true };
      },
      async planReconcile() {
        return { grants: 1, toShare: [{ grantId: "g", fileId: FILE, roleId: "role_a", email: "b@gmail.com", driveRole: "reader" as const }], toRevoke: [], orphanGrants: [], withoutGmail: 0 };
      },
      async applyReconcile() {
        calls.push("apply");
        return { shared: 1, revoked: 0, skipped: [], remaining: 0 };
      },
    } as unknown as RoleGrantsService;
    const deps: RoleFollowDeps = {
      roleGrants: async () => ({ service: roleGrants, live: opts.live ?? true }),
      meetings: async () => ({
        followsAnyRole: async () => opts.follows ?? false,
        plan: async () => ({ meetings: 1, skippedPast: 0, toInvite: [{ meetingId: "m", title: "t", email: "b@gmail.com" }], toUninvite: [], removalsHeld: [] }),
        syncRoles: async (roleIds) => {
          synced.push(roleIds === "all" ? "all" : roleIds.join(","));
          if (opts.calFail) throw opts.calFail;
          return { meetings: 1, invitedAdded: 1, invitedRemoved: 0, complete: true, ...(opts.calSkipped ? { skipped: opts.calSkipped } : {}) };
        },
      }),
      kickCalendar: async () => void kicks.push(1),
    };
    return { svc: createRoleFollowService(deps), kicks, calls, synced };
  }

  it("validates the message; a malformed one is acknowledged and dropped (retrying cannot fix it)", async () => {
    expect(parseMembershipMessage(msg())).not.toBeNull();
    expect(parseMembershipMessage({ ...msg(), roleIds: [] })).toBeNull();
    expect(parseMembershipMessage({ ...msg(), change: "moved" })).toBeNull();
    const { svc, calls } = follow();
    expect(await svc.handle({ nope: 1 })).toMatchObject({ ignored: true });
    expect(calls).toEqual([]);
  });

  it("follows Drive and the meeting attendees in the same call; calendar only when a live meeting invites the role", async () => {
    const a = follow({ follows: true });
    const res = await a.svc.handle(msg({ change: "removed", roleIds: ["role_a", "role_b"] }));
    expect(res).toMatchObject({ complete: true, problems: [], drive: { shared: 1, complete: true }, calendar: { meetings: 1, invitedAdded: 1, complete: true, sharesPending: true } });
    expect(a.calls).toEqual(["removed:role_a,role_b"]);
    expect(a.synced).toEqual(["role_a,role_b"]); // attendees reconciled directly, not deferred
    expect(a.kicks).toHaveLength(1); // only the paced calendar shares go through the DO

    const b = follow({ follows: false });
    expect(await b.svc.handle(msg())).toMatchObject({ calendar: null, complete: true });
    expect(b.synced).toEqual([]);
    expect(b.kicks).toHaveLength(0);
  });

  it("no Google account: Drive is skipped without a problem", async () => {
    const { svc, calls } = follow({ live: false });
    expect(await svc.handle(msg())).toMatchObject({ drive: null, complete: true });
    expect(calls).toEqual([]);
  });

  it("never throws: an unfinished, refused or failed part is reported in problems, the other part still runs", async () => {
    const unfinished = await follow({ complete: false }).svc.handle(msg());
    expect(unfinished.complete).toBe(false);
    expect(unfinished.problems.join()).toContain("時間内に終わりませんでした");

    const refused = await follow({ skipped: [{ email: "x@gmail.com", reason: "拒否" }] }).svc.handle(msg());
    expect(refused.problems.join()).toContain("x@gmail.com");

    const quota = follow({ fail: new GoogleQuotaError("drive", "rateLimitExceeded"), follows: true });
    const r = await quota.svc.handle(msg());
    expect(r).toMatchObject({ complete: false, drive: null, calendar: { invitedAdded: 1 } });
    expect(r.problems.join()).toContain("Drive共有を反映できませんでした");

    const cal = await follow({ follows: true, calFail: new Error("calendar down") }).svc.handle(msg());
    expect(cal).toMatchObject({ complete: false, drive: { shared: 1 }, calendar: null });
    expect(cal.problems.join()).toContain("ミーティングの招待を反映できませんでした");

    const paused = await follow({ follows: true, calSkipped: "quota_paused" }).svc.handle(msg());
    expect(paused).toMatchObject({ complete: false, calendar: { complete: false, skipped: "quota_paused" } });
  });

  it("the backfill is a dry-run unless dryRun: false is explicit", async () => {
    const dry = follow();
    const plan = await dry.svc.reconcile({});
    expect(plan.dryRun).toBe(true);
    expect(plan.applied).toBeUndefined();
    expect(plan.drive.toShare).toHaveLength(1);
    expect(dry.calls).toEqual([]);
    expect(dry.kicks).toHaveLength(0);
    expect((await dry.svc.reconcile(null)).dryRun).toBe(true);

    const wet = follow();
    const res = await wet.svc.reconcile({ dryRun: false });
    expect(res).toMatchObject({ dryRun: false, applied: { shared: 1, remaining: 0, calendarSyncKicked: true, calendarInvited: 1, calendarComplete: true } });
    expect(wet.calls).toEqual(["apply"]);
    expect(wet.synced).toEqual(["all"]);
    expect(wet.kicks).toHaveLength(1);

    await expect(follow({ live: false }).svc.reconcile({ dryRun: false })).rejects.toThrow();
  });
});

describe("routes", () => {
  function app(keys: Parameters<typeof memAuthzHolding>) {
    const { svc } = (() => {
      const deps: RoleFollowDeps = {
        roleGrants: async () => ({ service: { planReconcile: async () => ({ grants: 0, toShare: [], toRevoke: [], orphanGrants: [], withoutGmail: 0 }) } as unknown as RoleGrantsService, live: true }),
        meetings: async () => ({
          followsAnyRole: async () => false,
          plan: async () => ({ meetings: 0, skippedPast: 0, toInvite: [], toUninvite: [], removalsHeld: [] }),
          syncRoles: async () => ({ meetings: 0, invitedAdded: 0, invitedRemoved: 0, complete: true }),
        }),
        kickCalendar: async () => {},
      };
      return { svc: createRoleFollowService(deps) };
    })();
    const roleGrants = buildRoleGrants({ drive: createMockDriveShareClient(), roster: fakeRoster({}) }).service;
    return createApp({
      service: createDriveShareService({ client: createMockDriveShareClient(), config: { listPageSize: 50 } }),
      roleGrants,
      authz: memAuthzHolding(...keys),
      googleAccount: stubGoogleAccount(),
      meetings: async () => buildMeetings().service,
      attendance: () => {
        throw new Error("unused");
      },
      googleLink: () => {
        throw new Error("unused");
      },
      roleFollow: () => svc,
    });
  }

  it("POST /internal/role-membership is s2s only", async () => {
    const a = app([]);
    const external = await a.request("/internal/role-membership", { method: "POST", headers: { ...AUTHED, "content-type": "application/json" }, body: "{}" });
    expect(external.status).toBe(403);
    const internal = await a.request("/internal/role-membership", { method: "POST", headers: { "x-dub-internal": "1", "content-type": "application/json" }, body: "{}" });
    expect(internal.status).toBe(200);
    expect(await internal.json()).toMatchObject({ ignored: true });
  });

  it("POST /driveshare/role-grants/reconcile needs the Drive共有 settings keys and defaults to a dry-run", async () => {
    const editor = await app(["app:driveshare:view", "app:driveshare:edit", "drive:read", "drive:write"]).request("/driveshare/role-grants/reconcile", { method: "POST", headers: AUTHED });
    expect(editor.status).toBe(403);
    const admin = await app(["app:driveshare:view", "app:driveshare:edit", "drive:settings_view", "drive:settings_edit"]).request("/driveshare/role-grants/reconcile", { method: "POST", headers: AUTHED });
    expect(admin.status).toBe(200);
    expect(await admin.json()).toMatchObject({ dryRun: true });
  });
});
