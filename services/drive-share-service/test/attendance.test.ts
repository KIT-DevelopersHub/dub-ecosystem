// 定例の出席: join window → present record, instance check, my 定例 list, the 人事 report (expected /
// rate), manual corrections, trackAttendance on meetings, and the HTTP surface through the gate.
import { describe, it, expect } from "vitest";
import { meeting } from "@dub/types";
import { createApp } from "../src/app";
import { createDriveShareService } from "../src/service";
import { createMockDriveShareClient } from "../src/mock-client";
import { openOccurrence } from "../src/attendance-service";
import { createInMemoryAttendanceStore } from "../src/attendance-store";
import { createInMemoryMeetingStore, type MeetingRow } from "../src/meetings-store";
import type { ActiveUser } from "../src/role-membership";
import { AUTHED, buildAttendance, buildMeetings, buildRoleGrants, fakeRoster, memAuthzHolding, stubGoogleAccount } from "./helpers";

const USERS: ActiveUser[] = [
  { id: "usr_1", email: "one@dub.example", name: "一郎", roleIds: ["role_dev"] },
  { id: "usr_2", email: "two@dub.example", name: "二郎", roleIds: ["role_dev"] },
  { id: "usr_3", email: "three@dub.example", name: "三郎", roleIds: ["role_pr"] },
];
const roster = () => fakeRoster({}, { role_dev: "開発", role_pr: "広報" }, USERS);

function row(over: Partial<MeetingRow>): MeetingRow {
  return {
    id: "dsm_all",
    orgId: "org_default",
    targetId: "all",
    accountId: "dga_1",
    calendarId: "cal",
    googleEventId: "ev",
    title: "全体定例",
    description: null,
    startsAt: "2026-10-05T12:00:00.000Z", // 月 21:00 JST, weekly
    durationMinutes: 60,
    recurrence: "weekly",
    until: null,
    meetUrl: "https://meet.google.com/abc-defg-hij",
    htmlLink: null,
    createdBy: "usr_admin",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    syncedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

async function setup(now: string) {
  const meetings = createInMemoryMeetingStore();
  const store = createInMemoryAttendanceStore();
  const org = (await import("@dub/types")).common.DUB_DEFAULT_ORG_ID;
  await meetings.insertMeeting(row({ orgId: org }));
  await meetings.insertMeeting(row({ orgId: org, id: "dsm_dev", targetId: "role_dev", title: "開発定例", startsAt: "2026-10-07T11:00:00.000Z" })); // 水 20:00 JST
  await meetings.insertMeeting(row({ orgId: org, id: "dsm_once", title: "単発", recurrence: "none", startsAt: "2026-10-12T12:00:00.000Z" }));
  await store.setRegular(org, "dsm_all", true, "usr_admin", now);
  await store.setRegular(org, "dsm_dev", true, "usr_admin", now);
  let clock = now;
  const svc = buildAttendance({ roster: roster(), meetings, store, now: () => clock });
  return { ...svc, setNow: (n: string) => (clock = n), org };
}

describe("openOccurrence (join window)", () => {
  const m = row({});
  it("opens 30 minutes before the start and closes at the end", () => {
    expect(openOccurrence(m, "2026-10-12T11:29:00.000Z")).toBeNull();
    expect(openOccurrence(m, "2026-10-12T11:30:00.000Z")).toEqual({ date: "2026-10-12", startsAt: "2026-10-12T12:00:00.000Z" });
    expect(openOccurrence(m, "2026-10-12T13:00:00.000Z")?.date).toBe("2026-10-12");
    expect(openOccurrence(m, "2026-10-12T13:00:01.000Z")).toBeNull();
    expect(openOccurrence(m, "2026-10-13T12:10:00.000Z")).toBeNull(); // Tuesday: no occurrence
  });

  it("keys a late-night occurrence by its JST date", () => {
    const late = row({ startsAt: "2026-10-05T14:45:00.000Z" }); // 月 23:45 JST
    expect(openOccurrence(late, "2026-10-12T15:10:00.000Z")?.date).toBe("2026-10-12"); // 火 00:10 JST
  });
});

describe("join", () => {
  it("records the caller present for the open occurrence, keeping the first join time", async () => {
    const t = await setup("2026-10-12T12:05:00.000Z");
    expect(await t.service.join("usr_3", "dsm_all")).toEqual({ meetUrl: "https://meet.google.com/abc-defg-hij", recordedFor: "2026-10-12" });
    t.setNow("2026-10-12T12:20:00.000Z");
    await t.service.join("usr_3", "dsm_all");
    const r = await t.store.get("dsm_all", "2026-10-12", "usr_3");
    expect(r).toMatchObject({ status: "present", source: "join", joinedAt: "2026-10-12T12:05:00.000Z", recordedBy: "usr_3" });
  });

  it("outside the window: returns the link, records nothing", async () => {
    const t = await setup("2026-10-12T09:00:00.000Z");
    expect(await t.service.join("usr_1", "dsm_all")).toEqual({ meetUrl: "https://meet.google.com/abc-defg-hij", recordedFor: null });
    expect(t.store.rows.size).toBe(0);
  });

  it("a meeting that is not a 定例 records nothing", async () => {
    const t = await setup("2026-10-12T12:05:00.000Z");
    expect((await t.service.join("usr_1", "dsm_once")).recordedFor).toBeNull();
    expect(t.store.rows.size).toBe(0);
  });

  it("a non-member of the target is refused (instance check)", async () => {
    const t = await setup("2026-10-14T11:05:00.000Z");
    await expect(t.service.join("usr_3", "dsm_dev")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await t.service.join("usr_1", "dsm_dev")).recordedFor).toBe("2026-10-14");
  });

  it("joining overrides an earlier 欠席連絡 (excused) with present", async () => {
    const t = await setup("2026-10-12T12:05:00.000Z");
    await t.service.set("usr_admin", "dsm_all", "2026-10-12", "usr_2", { status: "excused" });
    await t.service.join("usr_2", "dsm_all");
    expect((await t.store.get("dsm_all", "2026-10-12", "usr_2"))?.status).toBe("present");
  });

  it("unknown meeting -> 404", async () => {
    const t = await setup("2026-10-12T12:05:00.000Z");
    await expect(t.service.join("usr_1", "dsm_nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("myRegulars", () => {
  it("lists the caller's 定例 (全体 + own team), open ones first, with attended", async () => {
    const t = await setup("2026-10-12T12:05:00.000Z");
    await t.service.join("usr_1", "dsm_all");
    const { items } = await t.service.myRegulars("usr_1");
    expect(items.map((i) => [i.id, i.kind, i.targetName, i.joinOpen, i.attended])).toEqual([
      ["dsm_all", "all_hands", "全体", true, true],
      ["dsm_dev", "team", "開発", false, false],
    ]);
    expect(items[1]!.next).toEqual({ date: "2026-10-14", startsAt: "2026-10-14T11:00:00.000Z" });
    expect((await t.service.myRegulars("usr_3")).items.map((i) => i.id)).toEqual(["dsm_all"]);
  });
});

describe("report", () => {
  it("expected = current target members; rate = present / (expected - excused); started occurrences only", async () => {
    const t = await setup("2026-10-12T12:05:00.000Z");
    await t.service.join("usr_1", "dsm_all"); // 10-12
    t.setNow("2026-10-14T11:10:00.000Z");
    await t.service.join("usr_1", "dsm_dev"); // 10-14
    await t.service.set("usr_admin", "dsm_all", "2026-10-05", "usr_2", { status: "excused" });
    await t.service.set("usr_admin", "dsm_all", "2026-10-05", "usr_1", { status: "present" });

    const r = await t.service.report({ from: "2026-10-01", to: "2026-10-31" });
    expect(r.from).toBe("2026-10-01");
    const all = r.meetings.find((m) => m.id === "dsm_all")!;
    expect(all.kind).toBe("all_hands");
    expect(all.expectedUserIds).toEqual(["usr_1", "usr_2", "usr_3"]);
    expect(all.occurrences.map((o) => o.date)).toEqual(["2026-10-12", "2026-10-05"]); // 10-19 not started yet
    const dev = r.meetings.find((m) => m.id === "dsm_dev")!;
    expect(dev.targetName).toBe("開発");
    expect(dev.occurrences.map((o) => o.date)).toEqual(["2026-10-14", "2026-10-07"]);

    const by = Object.fromEntries(r.members.map((m) => [m.userId, m]));
    expect(by.usr_1).toMatchObject({ expected: 4, present: 3, excused: 0, rate: 0.75 });
    expect(by.usr_2).toMatchObject({ expected: 4, present: 0, excused: 1, rate: 0 });
    expect(by.usr_3).toMatchObject({ expected: 2, present: 0, excused: 0, rate: 0 });
    expect(r.members[r.members.length - 1]!.userId).toBe("usr_1"); // lowest rate first
    expect(r.meetings.some((m) => m.id === "dsm_once")).toBe(false);
  });

  it("defaults to the last 12 weeks and validates the range", async () => {
    const t = await setup("2026-10-12T12:05:00.000Z");
    const r = await t.service.report({});
    expect([r.from, r.to]).toEqual(["2026-07-21", "2026-10-12"]);
    await expect(t.service.report({ from: "2026-13-01" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(t.service.report({ from: "2026-10-10", to: "2026-10-01" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(t.service.report({ from: "2025-01-01", to: "2026-10-01" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("set (人事の修正)", () => {
  it("sets / clears a record; the date must be an occurrence; the member must be expected", async () => {
    const t = await setup("2026-10-12T12:05:00.000Z");
    const res = await t.service.set("usr_admin", "dsm_dev", "2026-10-07", "usr_2", { status: "present" });
    expect(res.record).toMatchObject({ userId: "usr_2", status: "present", source: "manual", recordedBy: "usr_admin", joinedAt: null });
    expect(await t.service.set("usr_admin", "dsm_dev", "2026-10-07", "usr_2", { status: null })).toEqual({ record: null });
    expect(t.store.rows.size).toBe(0);
    await expect(t.service.set("usr_admin", "dsm_dev", "2026-10-08", "usr_2", { status: "present" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(t.service.set("usr_admin", "dsm_dev", "2026-10-07", "usr_3", { status: "present" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(t.service.set("usr_admin", "dsm_dev", "2026-10-07", "usr_2", { status: "late" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("trackAttendance on meetings", () => {
  const BASE = { title: "開発定例", targetId: "role_dev", startsAt: "2026-10-20T10:00:00.000Z", durationMinutes: 60, recurrence: "weekly" };

  it("create / update / list carry the flag; a bad value is rejected", async () => {
    const { service, attendance } = buildMeetings({ roster: roster() });
    const m = await service.create("usr_admin", { ...BASE, trackAttendance: true });
    expect(m.trackAttendance).toBe(true);
    expect(attendance.regulars.has(m.id)).toBe(true);
    expect((await service.list()).items[0]!.trackAttendance).toBe(true);
    expect((await service.update(m.id, { title: "改名" }, "usr_admin")).trackAttendance).toBe(true);
    expect((await service.update(m.id, { trackAttendance: false }, "usr_admin")).trackAttendance).toBe(false);
    expect(attendance.regulars.has(m.id)).toBe(false);
    await expect(service.create("usr_admin", { ...BASE, trackAttendance: "yes" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await service.create("usr_admin", BASE)).trackAttendance).toBe(false);
  });
});

describe("HTTP surface", () => {
  async function appWith(...keys: Parameters<typeof memAuthzHolding>) {
    const t = await setup("2026-10-12T12:05:00.000Z");
    const client = createMockDriveShareClient();
    const { service: roleGrants } = buildRoleGrants({ drive: client, roster: fakeRoster({}) });
    const app = createApp({
      service: createDriveShareService({ client, config: { listPageSize: 50 } }),
      roleGrants,
      authz: memAuthzHolding(...keys),
      googleAccount: stubGoogleAccount(),
      meetings: async () => buildMeetings().service,
      attendance: () => t.service,
    });
    return { app, t };
  }
  const JSON_HDR = { ...AUTHED, "content-type": "application/json" };

  it("any signed-in member joins and lists their 定例; the report needs 人事", async () => {
    const { app } = await appWith();
    const join = await app.request("/meetings/dsm_all/join", { method: "POST", headers: AUTHED });
    expect(join.status).toBe(200);
    expect(((await join.json()) as meeting.JoinMeetingResponse).recordedFor).toBe("2026-10-12");
    expect((await app.request("/meetings/me/regulars", { headers: AUTHED })).status).toBe(200);
    expect((await app.request("/meetings/attendance", { headers: AUTHED })).status).toBe(403);
    expect((await app.request("/meetings/dsm_all/join", { method: "POST" })).status).toBe(401);
  });

  it("人事 閲覧 reads the report but cannot correct; 編集 + hr:write can", async () => {
    const viewer = await appWith("app:hr:view", "hr:read");
    const rep = await viewer.app.request("/meetings/attendance?from=2026-10-01&to=2026-10-31", { headers: AUTHED });
    expect(rep.status).toBe(200);
    expect(((await rep.json()) as meeting.AttendanceReportResponse).meetings).toHaveLength(2);
    const put = (app: typeof viewer.app) =>
      app.request("/meetings/dsm_all/attendance/2026-10-05/usr_2", { method: "PUT", headers: JSON_HDR, body: JSON.stringify({ status: "excused" }) });
    expect((await put(viewer.app)).status).toBe(403);
    const editor = await appWith("app:hr:view", "app:hr:edit", "hr:read", "hr:write");
    const ok = await put(editor.app);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as meeting.SetAttendanceResponse).record).toMatchObject({ status: "excused", recordedBy: "usr_1" });
  });
});
