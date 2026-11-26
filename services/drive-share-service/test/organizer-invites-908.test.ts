// #908 「Organizer ロールを持っているのにカレンダー（定例の招待）に入っていない人がいる」.
// One test per suspected cause. The causes the code already handles stay as regression guards; the
// real gap — a target member Dub cannot (or did not yet) invite was invisible — is what the
// notInvited list, 参加者を再同期 (syncOne) and the outbox retry flag fix.
import { describe, it, expect, vi } from "vitest";
import { identity, meeting } from "@dub/types";
import type { Fetcher } from "@cloudflare/workers-types";
import { createApp } from "../src/app";
import { createDriveShareService } from "../src/service";
import { createMockDriveShareClient } from "../src/mock-client";
import { createInMemoryMeetingStore } from "../src/meetings-store";
import { createInMemorySyncState } from "../src/meeting-sync-state";
import { staticMemberDirectory, type MemberDirectory } from "../src/member-directory";
import { createIdentityRoleMembership, type ActiveUser } from "../src/role-membership";
import { createRoleFollowService, type RoleFollowDeps } from "../src/role-follow";
import type { RoleGrantsService } from "../src/role-grants-service";
import { buildMeetings, buildRoleGrants, fakeRoster, memAuthzHolding, stubGoogleAccount } from "./helpers";

const ORGANIZER = "role_sys_organizer";
const NAMES = { [ORGANIZER]: "organizer" };
const BASE = { title: "運営定例", targetId: ORGANIZER, startsAt: "2026-10-20T10:00:00.000Z", durationMinutes: 60, recurrence: "weekly" };

const users = (...list: [id: string, roleIds: string[]][]): ActiveUser[] =>
  list.map(([id, roleIds]) => ({ id, email: `${id}@developershub.jp`, name: id, roleIds }));
const gmail = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, { gmail: `${id}@gmail.com`, name: id }]));

type MockCal = { state: { calendars: Map<string, { events: Map<string, { attendees: { email: string }[] }> }> } };
const attendeesOnGoogle = (calendar: unknown) =>
  [...[...(calendar as MockCal).state.calendars.values()][0]!.events.values()][0]!.attendees.map((a) => a.email).sort();

/** A roster whose membership can change between calls (a role assigned after the meeting was made). */
function liveRoster(initial: ActiveUser[]) {
  let current = initial;
  return {
    roster: {
      ...fakeRoster({}, NAMES),
      listActiveUsers: async (roleId?: string) => current.filter((u) => !roleId || u.roleIds.includes(roleId)).map((u) => ({ ...u, roleIds: [...u.roleIds] })),
    },
    set: (next: ActiveUser[]) => void (current = next),
  };
}

describe("#908 cause: Organizer assigned after the meeting was made", () => {
  it("is followed: the role sync (identity's notice) invites them on the live meeting", async () => {
    const r = liveRoster(users(["usr_a", [ORGANIZER]]));
    const { service, calendar } = buildMeetings({ roster: r.roster, directory: staticMemberDirectory(gmail("usr_a", "usr_b")) });
    await service.create("usr_admin", BASE);
    r.set(users(["usr_a", [ORGANIZER]], ["usr_b", [ORGANIZER]]));
    const res = await service.syncRoles([ORGANIZER]);
    expect(res).toMatchObject({ meetings: 1, invitedAdded: 1, complete: true });
    expect(attendeesOnGoogle(calendar)).toEqual(["usr_a@gmail.com", "usr_b@gmail.com"]);
  });
});

describe("#908 cause: no 名簿 Gmail (or no 名簿 row linked to the account)", () => {
  it("is never invited — and the meeting now says so (メールアドレス未連携) instead of hiding them", async () => {
    const roster = fakeRoster({}, NAMES, users(["usr_a", [ORGANIZER]], ["usr_nogmail", [ORGANIZER]], ["usr_unlinked", [ORGANIZER]]));
    // usr_nogmail: 名簿 row without Gmail; usr_unlinked: no 名簿 row for the account at all.
    const directory = staticMemberDirectory({ ...gmail("usr_a"), usr_nogmail: { gmail: null, name: "usr_nogmail" } });
    const { service, calendar } = buildMeetings({ roster, directory });
    const m = await service.create("usr_admin", BASE);
    expect(attendeesOnGoogle(calendar)).toEqual(["usr_a@gmail.com"]);

    const res = await service.attendees(m.id);
    expect(res.items.map((i) => i.userId)).toEqual(["usr_a"]);
    expect(res.notInvited).toEqual([
      { userId: "usr_nogmail", name: "usr_nogmail", reason: "no_email" },
      { userId: "usr_unlinked", name: "usr_unlinked", reason: "no_email" },
    ]);
  });

  it("members outside the meeting's targets and org bot mailboxes are not flagged", async () => {
    const roster = fakeRoster({}, NAMES, [
      ...users(["usr_a", [ORGANIZER]], ["usr_other", ["role_member"]]),
      { id: "usr_bot", email: "member@developershub.jp", name: "member", roleIds: [ORGANIZER] },
    ]);
    const directory = staticMemberDirectory({ ...gmail("usr_a"), usr_bot: { gmail: "member@developershub.jp", name: "member" } });
    const { service } = buildMeetings({ roster, directory });
    const m = await service.create("usr_admin", BASE);
    expect((await service.attendees(m.id)).notInvited).toEqual([]);
  });

  it("a fully invited meeting reads no 名簿 for it (rows read are near the free-tier cap)", async () => {
    const roster = fakeRoster({}, NAMES, users(["usr_a", [ORGANIZER]]));
    const inner = staticMemberDirectory(gmail("usr_a"));
    const directory: MemberDirectory = { googleEmails: vi.fn(inner.googleEmails) };
    const { service } = buildMeetings({ roster, directory });
    const m = await service.create("usr_admin", BASE);
    vi.mocked(directory.googleEmails).mockClear();
    expect((await service.attendees(m.id)).notInvited).toEqual([]);
    expect(directory.googleEmails).not.toHaveBeenCalled();
  });

  it("a 名簿 outage shows nothing rather than flagging everyone as 未連携", async () => {
    const r = liveRoster(users(["usr_a", [ORGANIZER]]));
    let down = false;
    const inner = staticMemberDirectory(gmail("usr_a", "usr_b"));
    const directory: MemberDirectory = {
      googleEmails: async (ids, opts) => {
        if (down && opts?.strict) throw new Error("member-service down");
        return inner.googleEmails(ids);
      },
    };
    const { service } = buildMeetings({ roster: r.roster, directory });
    const m = await service.create("usr_admin", BASE);
    r.set(users(["usr_a", [ORGANIZER]], ["usr_b", [ORGANIZER]]));
    down = true;
    expect((await service.attendees(m.id)).notInvited).toEqual([]);
  });
});

describe("#908 cause: invitable but the follow was missed (identity's call failed / timed out)", () => {
  it("shows as 未招待, and 参加者を再同期 (syncOne) invites them on that meeting now", async () => {
    const r = liveRoster(users(["usr_a", [ORGANIZER]]));
    const { service, calendar, kicks } = buildMeetings({ roster: r.roster, directory: staticMemberDirectory(gmail("usr_a", "usr_b")) });
    const m = await service.create("usr_admin", BASE);
    r.set(users(["usr_a", [ORGANIZER]], ["usr_b", [ORGANIZER]], ["usr_c", [ORGANIZER]]));
    expect((await service.attendees(m.id)).notInvited).toEqual([
      { userId: "usr_c", name: "usr_c", reason: "no_email" },
      { userId: "usr_b", name: "usr_b", reason: "pending" },
    ]);

    kicks.length = 0;
    const res = await service.syncOne(m.id);
    expect(res).toEqual({ invitedAdded: 1, invitedRemoved: 0, notInvited: [{ userId: "usr_c", name: "usr_c", reason: "no_email" }] });
    expect(attendeesOnGoogle(calendar)).toEqual(["usr_a@gmail.com", "usr_b@gmail.com"]);
    expect(kicks.length).toBeGreaterThan(0); // the target calendar's share follows in the paced sync
    expect((await service.attendees(m.id)).notInvited.map((n) => n.reason)).toEqual(["no_email"]);
  });

  it("syncOne: unknown meeting 404, missing calendar scope 409, a quota pause is not bypassed", async () => {
    const roster = fakeRoster({}, NAMES, users(["usr_a", [ORGANIZER]]));
    const store = createInMemoryMeetingStore();
    const syncState = createInMemorySyncState();
    const { service } = buildMeetings({ roster, store, syncState });
    const m = await service.create("usr_admin", BASE);
    await expect(service.syncOne("nope")).rejects.toMatchObject({ status: 404 });
    await expect(buildMeetings({ roster, store, calendarReady: false }).service.syncOne(m.id)).rejects.toMatchObject({ status: 409 });
    await expect(buildMeetings({ roster, store, accountId: "dga_other" }).service.syncOne(m.id)).rejects.toMatchObject({ status: 409 });
    await syncState.pause(0, Date.parse("2099-01-01T00:00:00.000Z"));
    await expect(service.syncOne(m.id)).rejects.toThrow();
  });

  it("an ended meeting's attendees are frozen: nothing is listed as still to invite", async () => {
    const r = liveRoster(users(["usr_a", [ORGANIZER]]));
    let now = "2026-12-01T00:00:00.000Z";
    const { service } = buildMeetings({ roster: r.roster, directory: staticMemberDirectory(gmail("usr_a", "usr_b")), now: () => now });
    const m = await service.create("usr_admin", { ...BASE, startsAt: "2026-12-02T10:00:00.000Z", recurrence: "none" });
    r.set(users(["usr_a", [ORGANIZER]], ["usr_b", [ORGANIZER]]));
    expect((await service.attendees(m.id)).notInvited.map((n) => n.userId)).toEqual(["usr_b"]);
    now = "2026-12-10T00:00:00.000Z";
    expect((await service.attendees(m.id)).notInvited).toEqual([]);
  });
});

describe("#908 cause: event-scoped Organizer (organizer of one event only)", () => {
  it("is not an org-wide Organizer: identity's roleIds carry org-wide roles only, so the meeting neither invites nor flags them", async () => {
    // identity returns roleIds = org-wide assignments; an event-scoped one never appears there.
    const roster = fakeRoster({}, NAMES, users(["usr_a", [ORGANIZER]], ["usr_event_only", []]));
    const { service } = buildMeetings({ roster, directory: staticMemberDirectory(gmail("usr_a", "usr_event_only")) });
    const m = await service.create("usr_admin", BASE);
    const res = await service.attendees(m.id);
    expect(res.items.map((i) => i.userId)).toEqual(["usr_a"]);
    expect(res.notInvited).toEqual([]);
  });
});

describe("#908 cause: pagination of the identity roster", () => {
  it("reads every page (more than one page of active users)", async () => {
    const all = Array.from({ length: 250 }, (_, i) => ({ id: `usr_${String(i).padStart(3, "0")}`, email: `u${i}@developershub.jp`, displayName: `u${i}`, roleIds: [ORGANIZER] }));
    const binding = {
      fetch: async (req: Request) => {
        const url = new URL(req.url);
        const limit = Number(url.searchParams.get("limit"));
        const cursor = url.searchParams.get("cursor") ?? "";
        const page = all.filter((u) => u.id > cursor).slice(0, limit);
        const body = { items: page, nextCursor: page.length === limit ? page[page.length - 1]!.id : null };
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      },
    } as unknown as Fetcher;
    const roster = createIdentityRoleMembership(binding, { requestId: "req_908" });
    expect(await roster.listActiveUsers()).toHaveLength(250);
    expect(await roster.listActiveUsers(ORGANIZER)).toHaveLength(250);
  });
});

describe("#908 fix: a missed follow is retried through the outbox", () => {
  const msg = (): identity.RoleMembershipChangedV1 => ({
    type: "identity.role_membership.changed",
    version: 1,
    id: "rm_908",
    occurredAt: "2026-11-27T00:00:00.000Z",
    orgId: "org_devhub" as identity.RoleMembershipChangedV1["orgId"],
    userId: "usr_b" as identity.RoleMembershipChangedV1["userId"],
    change: "added",
    roleIds: [ORGANIZER as identity.RoleMembershipChangedV1["roleIds"][number]],
    reason: "assign",
  });

  function follow(cal: { fail?: boolean; skipped?: "quota_paused" | "not_ready"; complete?: boolean }, drive: { refused?: boolean } = {}) {
    const deps: RoleFollowDeps = {
      roleGrants: async () => ({
        service: {
          followRoles: async () => ({ grants: 1, shared: 1, revoked: 0, held: 0, complete: true, skipped: drive.refused ? [{ email: "x@gmail.com", reason: "refused" }] : [] }),
        } as unknown as RoleGrantsService,
        live: true,
      }),
      meetings: async () => ({
        followsAnyRole: async () => true,
        plan: async () => ({ meetings: 0, skippedPast: 0, toInvite: [], toUninvite: [], removalsHeld: [] }),
        syncRoles: async () => {
          if (cal.fail) throw new Error("calendar down");
          return { meetings: 1, invitedAdded: 1, invitedRemoved: 0, complete: cal.complete ?? true, ...(cal.skipped ? { skipped: cal.skipped } : {}) };
        },
      }),
      kickCalendar: async () => {},
    };
    return createRoleFollowService(deps);
  }

  it("retry is set only when a later run can finish it", async () => {
    expect((await follow({}).handle(msg())).retry).toBeUndefined();
    expect((await follow({ fail: true }).handle(msg())).retry).toBe(true);
    expect((await follow({ complete: false }).handle(msg())).retry).toBe(true);
    expect((await follow({ skipped: "quota_paused" }).handle(msg())).retry).toBe(true);
    // Reconnecting the Google account / an address Google refuses: retrying changes nothing.
    expect((await follow({ skipped: "not_ready" }).handle(msg())).retry).toBeUndefined();
    expect((await follow({}, { refused: true }).handle(msg())).retry).toBeUndefined();
  });

  function app(svc: ReturnType<typeof follow>) {
    return createApp({
      service: createDriveShareService({ client: createMockDriveShareClient(), config: { listPageSize: 50 } }),
      roleGrants: buildRoleGrants({ drive: createMockDriveShareClient(), roster: fakeRoster({}) }).service,
      authz: memAuthzHolding(),
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

  it(`POST ${identity.ROLE_MEMBERSHIP_ASYNC_PATH}: s2s only; 503 while retryable (freeq retries), 200 when done`, async () => {
    const post = (a: ReturnType<typeof app>, headers: Record<string, string>) =>
      a.request(identity.ROLE_MEMBERSHIP_ASYNC_PATH, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(msg()) });
    expect((await post(app(follow({})), { "x-dub-user-id": "usr_1" })).status).toBe(403);
    expect((await post(app(follow({})), { "x-dub-internal": "1" })).status).toBe(200);
    expect((await post(app(follow({ fail: true })), { "x-dub-internal": "1" })).status).toBe(503);
    expect((await post(app(follow({ skipped: "not_ready" })), { "x-dub-internal": "1" })).status).toBe(200);
  });
});

describe("#908 POST /meetings/:id/sync", () => {
  it("needs ミーティング編集 (same as 招待を同期)", async () => {
    const roster = fakeRoster({}, NAMES, users(["usr_a", [ORGANIZER]]));
    const built = buildMeetings({ roster });
    const m = await built.service.create("usr_admin", BASE);
    const appWith = (...keys: Parameters<typeof memAuthzHolding>) =>
      createApp({
        service: createDriveShareService({ client: createMockDriveShareClient(), config: { listPageSize: 50 } }),
        roleGrants: buildRoleGrants({ drive: createMockDriveShareClient(), roster }).service,
        authz: memAuthzHolding(...keys),
        googleAccount: stubGoogleAccount(),
        meetings: async () => built.service,
        attendance: () => {
          throw new Error("unused");
        },
        googleLink: () => {
          throw new Error("unused");
        },
        roleFollow: () => {
          throw new Error("unused");
        },
      });
    const req = { method: "POST", headers: { "x-dub-user-id": "usr_1" } };
    expect((await appWith("app:calendar:view", "calendar:meetings_view").request(`/meetings/${m.id}/sync`, req)).status).toBe(403);
    const ok = await appWith("app:calendar:view", "app:calendar:edit", "calendar:meetings_view", "calendar:meetings_edit").request(`/meetings/${m.id}/sync`, req);
    expect(ok.status).toBe(200);
    expect((await ok.json()) as meeting.SyncMeetingResponse).toEqual({ invitedAdded: 0, invitedRemoved: 0, notInvited: [] });
  });
});
