// カレンダー > ミーティング: 複数の対象 (全体 / roles / members). A meeting invites the union of its
// targets; its event stays on one calendar (calendarTargetOf). The sync's safety rules apply per
// target: a deleted role contributes nobody, an existing role read as empty (or an unreadable role
// list) holds every removal, and a meeting whose targets all come back empty is never mass-uninvited.
import { describe, it, expect } from "vitest";
import { meeting } from "@dub/types";
import { createMockCalendarClient } from "../src/calendar-mock-client";
import { validateMeeting } from "../src/meeting-rules";
import type { ActiveUser } from "../src/role-membership";
import { buildMeetings, fakeRoster } from "./helpers";

const USERS: ActiveUser[] = [
  { id: "usr_a", email: "a@dub.example", name: "A", roleIds: ["role_dev"] },
  { id: "usr_b", email: "b@dub.example", name: "B", roleIds: ["role_dev", "role_pr"] },
  { id: "usr_c", email: "c@dub.example", name: "C", roleIds: ["role_pr"] },
  { id: "usr_d", email: "d@dub.example", name: "D", roleIds: [] },
];
const NAMES = { role_dev: "開発", role_pr: "広報" };

const role = (id: string): meeting.MeetingTargetRef => ({ kind: "role", id });
const person = (id: string): meeting.MeetingTargetRef => ({ kind: "person", id });
const ALL: meeting.MeetingTargetRef = { kind: "all", id: meeting.ALL_MEMBERS_TARGET_ID };

const BASE = {
  title: "合同定例",
  startsAt: "2026-10-20T10:00:00.000Z",
  durationMinutes: 60,
  recurrence: "weekly",
};

function setup() {
  const people = {
    users: USERS.map((u) => ({ ...u, roleIds: [...u.roleIds] })),
    roles: { ...NAMES } as Record<string, string>,
    rolesFail: false,
  };
  const roster = {
    ...fakeRoster({}, NAMES, USERS),
    listActiveUsers: async (roleId?: string) => people.users.filter((u) => !roleId || u.roleIds.includes(roleId)).map((u) => ({ ...u })),
    listRoles: async () => {
      if (people.rolesFail) throw new Error("identity unavailable");
      return Object.entries(people.roles).map(([id, name]) => ({ id, name }));
    },
  };
  const built = buildMeetings({ roster });
  const mock = built.calendar as ReturnType<typeof createMockCalendarClient>;
  const calendars = () => new Map([...mock.state.calendars.entries()].map(([id, c]) => [c.summary, { id, ...c }]));
  const eventOf = (calendarId: string) => [...mock.state.calendars.get(calendarId)!.events.values()][0]!;
  const invited = async (id: string) => (await built.store.listInvites(id)).map((i) => i.email).sort();
  /** Every member of a role leaves it; `deleted` also drops the role itself. */
  const empty = (roleId: string, deleted: boolean) => {
    for (const u of people.users) u.roleIds = u.roleIds.filter((r) => r !== roleId);
    if (deleted) delete people.roles[roleId];
  };
  return { ...built, mock, people, calendars, eventOf, invited, empty };
}

describe("parseMeetingTargets (the one validation, shared with the SPA)", () => {
  it("targets[] wins over the legacy targetId; duplicates drop, order stays", () => {
    expect(meeting.parseMeetingTargets({ targets: [role("r1"), person("u1"), role("r1")], targetId: "all" })).toEqual([role("r1"), person("u1")]);
  });

  it("the legacy single targetId still works (all / a role)", () => {
    expect(meeting.parseMeetingTargets({ targetId: "all" })).toEqual([ALL]);
    expect(meeting.parseMeetingTargets({ targetId: "role_dev" })).toEqual([role("role_dev")]);
  });

  it("refuses empty, malformed, an 'all' that is not kind all, and too many", () => {
    expect(meeting.parseMeetingTargets({})).toBeNull();
    expect(meeting.parseMeetingTargets({ targets: [] })).toBeNull();
    expect(meeting.parseMeetingTargets({ targets: [{ kind: "team", id: "x" }] })).toBeNull();
    expect(meeting.parseMeetingTargets({ targets: [{ kind: "role", id: "all" }] })).toBeNull();
    expect(meeting.parseMeetingTargets({ targets: [{ kind: "all", id: "role_dev" }] })).toBeNull();
    expect(meeting.parseMeetingTargets({ targets: Array.from({ length: 51 }, (_, i) => person(`u${i}`)) })).toBeNull();
  });

  it("validateMeeting keeps the stored targets on an update that does not name any", () => {
    const base = validateMeeting({ ...BASE, targets: [role("role_dev"), person("usr_c")] });
    expect(validateMeeting({ title: "改名" }, base).targets).toEqual([role("role_dev"), person("usr_c")]);
    expect(validateMeeting({ targetId: "all" }, base).targets).toEqual([ALL]);
  });

  it("the calendar: 全体 if a target, else the first role, else 個別", () => {
    expect(meeting.calendarTargetOf([person("u"), role("r2"), role("r1")])).toBe("r2");
    expect(meeting.calendarTargetOf([role("r1"), ALL])).toBe("all");
    expect(meeting.calendarTargetOf([person("u")])).toBe(meeting.PEOPLE_CALENDAR_TARGET_ID);
  });
});

describe("create with several targets", () => {
  it("invites the union of two roles and a person, once each; the event is on the first role's calendar", async () => {
    const { service, calendars, eventOf, invited } = setup();
    const m = await service.create("usr_admin", { ...BASE, targets: [role("role_dev"), role("role_pr"), person("usr_d")] });
    expect(m.targetId).toBe("role_dev");
    expect(m.targets).toEqual([
      { kind: "role", id: "role_dev", name: "開発" },
      { kind: "role", id: "role_pr", name: "広報" },
      { kind: "person", id: "usr_d", name: "D" },
    ]);
    expect(m.targetName).toBe("開発、広報、D");
    expect(m.attendeeCount).toBe(4);
    expect(await invited(m.id)).toEqual(["a@dub.example", "b@dub.example", "c@dub.example", "d@dub.example"]);
    const cals = calendars();
    expect([...cals.keys()]).toEqual(["開発"]); // no calendar per extra target
    expect(eventOf(cals.get("開発")!.id).attendees.map((a) => a.email).sort()).toEqual(["a@dub.example", "b@dub.example", "c@dub.example", "d@dub.example"]);
  });

  it("people only go on the 個別 calendar, which the sync shares with nobody", async () => {
    const { service, calendars, invited } = setup();
    const m = await service.create("usr_admin", { ...BASE, targets: [person("usr_c"), person("usr_d")] });
    expect(m.targetId).toBe(meeting.PEOPLE_CALENDAR_TARGET_ID);
    expect(await invited(m.id)).toEqual(["c@dub.example", "d@dub.example"]);
    await service.sync();
    const cal = calendars().get("個別")!;
    expect(cal.acl.filter((r) => r.role === "reader")).toEqual([]);
  });

  it("an unknown role or member is a 400; the legacy targetId body still creates", async () => {
    const { service } = setup();
    await expect(service.create("usr_admin", { ...BASE, targets: [role("role_gone")] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(service.create("usr_admin", { ...BASE, targets: [person("usr_gone")] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const legacy = await service.create("usr_admin", { ...BASE, targetId: "role_pr" });
    expect(legacy.targets).toEqual([{ kind: "role", id: "role_pr", name: "広報" }]);
    expect(legacy.targetName).toBe("広報");
  });

  it("targets() lists active members for person chips", async () => {
    const { service } = setup();
    const r = await service.targets("usr_a");
    expect(r.people?.map((p) => p.id)).toEqual(["usr_a", "usr_b", "usr_c", "usr_d"]);
  });
});

describe("sync over several targets", () => {
  async function made(targets: meeting.MeetingTargetRef[]) {
    const s = setup();
    const m = await s.service.create("usr_admin", { ...BASE, targets });
    await s.service.sync();
    return { ...s, m };
  }

  it("follows each target: a newcomer of the second role is added, a member leaving both is removed", async () => {
    const { service, people, invited, m } = await made([role("role_dev"), role("role_pr")]);
    people.users.find((u) => u.id === "usr_d")!.roleIds = ["role_pr"]; // joins 広報
    people.users.find((u) => u.id === "usr_a")!.roleIds = []; // leaves 開発
    const r = await service.sync();
    expect(r).toMatchObject({ invitedAdded: 1, invitedRemoved: 1 });
    expect(await invited(m.id)).toEqual(["b@dub.example", "c@dub.example", "d@dub.example"]);
  });

  it("one deleted role among several contributes nobody — the other targets' members stay invited", async () => {
    const { service, empty, invited, m } = await made([role("role_dev"), role("role_pr")]);
    empty("role_dev", true);
    await service.sync();
    // a was only in 開発 (deleted): uninvited. b and c are in 広報: kept.
    expect(await invited(m.id)).toEqual(["b@dub.example", "c@dub.example"]);
  });

  it("an existing role read as empty holds every removal (likelier a glitch)", async () => {
    const { service, empty, invited, m } = await made([role("role_dev"), role("role_pr")]);
    empty("role_dev", false);
    const r = await service.sync();
    expect(r.invitedRemoved).toBe(0);
    expect(await invited(m.id)).toEqual(["a@dub.example", "b@dub.example", "c@dub.example"]);
  });

  it("a failed role list read holds removals too (unknown never counts as deleted)", async () => {
    const { service, empty, people, invited, m } = await made([role("role_dev"), role("role_pr")]);
    empty("role_dev", true);
    people.rolesFail = true;
    const r = await service.sync();
    expect(r.invitedRemoved).toBe(0);
    expect(await invited(m.id)).toEqual(["a@dub.example", "b@dub.example", "c@dub.example"]);
  });

  it("every target deleted: the meeting keeps its invites; the role calendar loses Dub's shares (#812)", async () => {
    const { service, empty, people, invited, m, calendars, store } = await made([role("role_dev"), role("role_pr")]);
    const devCal = calendars().get("開発")!;
    expect((await store.listAcl("org_devhub", devCal.id)).length).toBe(2);
    people.roles.role_ops = "運営"; // an empty role list reads as unknown (#812), so one role remains
    empty("role_dev", true);
    empty("role_pr", true);
    const r = await service.sync();
    expect(r.invitedRemoved).toBe(0);
    expect(await invited(m.id)).toEqual(["a@dub.example", "b@dub.example", "c@dub.example"]);
    expect(await store.listAcl("org_devhub", devCal.id)).toEqual([]);
  });

  it("a person target who leaves Dub is uninvited; the role's members stay", async () => {
    const { service, people, invited, m } = await made([role("role_pr"), person("usr_a")]);
    expect(await invited(m.id)).toEqual(["a@dub.example", "b@dub.example", "c@dub.example"]);
    people.users = people.users.filter((u) => u.id !== "usr_a");
    await service.sync();
    expect(await invited(m.id)).toEqual(["b@dub.example", "c@dub.example"]);
  });

  it("a legacy meeting (one role) syncs exactly as before", async () => {
    const s = setup();
    const m = await s.service.create("usr_admin", { ...BASE, targetId: "role_dev" });
    s.people.users.find((u) => u.id === "usr_c")!.roleIds = ["role_pr", "role_dev"];
    const r = await s.service.sync();
    expect(r.invitedAdded).toBe(1);
    expect(await s.invited(m.id)).toEqual(["a@dub.example", "b@dub.example", "c@dub.example"]);
  });
});

describe("update targets", () => {
  it("adding a person and removing a role re-invites at once; a hand-added guest stays", async () => {
    const { service, calendars, eventOf, invited } = setup();
    const m = await service.create("usr_admin", { ...BASE, targets: [role("role_dev"), role("role_pr")] });
    const cal = calendars().get("開発")!;
    eventOf(cal.id).attendees.push({ email: "guest@example.com", responseStatus: "accepted" });

    const u = await service.update(m.id, { targets: [role("role_dev"), person("usr_d")] });
    expect(u.targetId).toBe("role_dev"); // same calendar: same event, same Meet
    expect(u.targetName).toBe("開発、D");
    expect(u.attendeeCount).toBe(3);
    expect(await invited(m.id)).toEqual(["a@dub.example", "b@dub.example", "d@dub.example"]);
    expect(eventOf(cal.id).attendees.map((a) => a.email).sort()).toEqual(["a@dub.example", "b@dub.example", "d@dub.example", "guest@example.com"]);
  });

  it("a change of the calendar target moves the event (as a target move did before)", async () => {
    const { service, calendars } = setup();
    const m = await service.create("usr_admin", { ...BASE, targets: [role("role_dev")] });
    const u = await service.update(m.id, { targets: [ALL, role("role_dev")] });
    expect(u.targetId).toBe("all");
    expect(calendars().get("全体")!.events.size).toBe(1);
    expect(calendars().get("開発")!.events.size).toBe(0);
  });

  it("a role deleted since does not block other edits; it stays until removed", async () => {
    const { service, empty } = setup();
    const m = await service.create("usr_admin", { ...BASE, targets: [role("role_dev"), role("role_pr")] });
    empty("role_pr", true);
    const u = await service.update(m.id, { title: "改名" });
    expect(u.targets.map((t) => t.name)).toEqual(["開発", "（削除されたロール）"]);
    await expect(service.update(m.id, { targets: [role("role_dev"), role("role_other")] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
