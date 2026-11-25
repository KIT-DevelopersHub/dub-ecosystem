// 定例の出席: Meet ingest (conference lookup, merge per person, sessions / approx fallback, budget,
// ledger, retention), the attendance precedence (manual > meet_api > join, threshold), matching
// (self / confirmed links, suggestions), the 人事 report, 「Googleと連携」 and the HTTP surface.
import { describe, it, expect, vi } from "vitest";
import { common, meeting } from "@dub/types";
import { createApp } from "../src/app";
import { createDriveShareService } from "../src/service";
import { createMockDriveShareClient } from "../src/mock-client";
import { effectiveRecord, openOccurrence, suggestMembers } from "../src/attendance-service";
import { createInMemoryAttendanceStore } from "../src/attendance-store";
import { createInMemoryMeetingStore, type MeetingRow } from "../src/meetings-store";
import { ingestCandidates, runMeetIngest, sessionSeconds } from "../src/meet-ingest";
import { createGoogleMeetRecordsClient, mapParticipant, type MeetParticipantRecord, type MeetRecordsClient } from "../src/google/meet-records-client";
import { subOfIdToken } from "../src/google-link";
import type { ActiveUser } from "../src/role-membership";
import type { Env } from "../src/env";
import { AUTHED, buildAttendance, buildGoogleLink, buildMeetings, buildRoleGrants, fakeRoster, memAuthzHolding, stubGoogleAccount } from "./helpers";

const ORG = common.DUB_DEFAULT_ORG_ID;
const USERS: ActiveUser[] = [
  { id: "usr_1", email: "one@dub.example", name: "山田 一郎", roleIds: ["role_dev"] },
  { id: "usr_2", email: "two@dub.example", name: "佐藤 二郎", roleIds: ["role_dev"] },
  { id: "usr_3", email: "three@dub.example", name: "鈴木 三郎", roleIds: ["role_pr"] },
];
const roster = () => fakeRoster({}, { role_dev: "開発", role_pr: "広報" }, USERS);
const MEET = "https://meet.google.com/abc-defg-hij";

function row(over: Partial<MeetingRow>): MeetingRow {
  const targetId = over.targetId ?? "all";
  return {
    targets: meeting.legacyTargets(targetId),
    id: "dsm_all",
    orgId: ORG,
    targetId: "all",
    accountId: "dga_1",
    calendarId: "cal",
    googleEventId: "ev",
    title: "全体定例",
    description: null,
    startsAt: "2026-10-05T12:00:00.000Z", // 月 21:00 JST, weekly, 60 min
    durationMinutes: 60,
    recurrence: "weekly",
    until: null,
    meetUrl: MEET,
    htmlLink: null,
    createdBy: "usr_admin",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    syncedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

function p(name: string, over: Partial<MeetParticipantRecord> = {}): MeetParticipantRecord {
  return { name, kind: "signed_in", googleUserId: null, displayName: "?", earliestStartTime: "2026-10-12T12:00:00Z", latestEndTime: "2026-10-12T13:00:00Z", ...over };
}

/** Fake Meet: conferences per meeting code, participants per conference, sessions per participant. */
function fakeMeet(data: {
  conferences?: Record<string, { name: string; startTime: string; endTime: string | null }[]>;
  participants?: Record<string, MeetParticipantRecord[]>;
  sessions?: Record<string, { startTime: string; endTime: string | null }[]>;
  fail?: boolean;
}) {
  const calls: string[] = [];
  const client: MeetRecordsClient = {
    async listConferences(code, from, to) {
      calls.push(`conf ${code} ${from} ${to}`);
      if (data.fail) throw new Error("google 500");
      return (data.conferences?.[code] ?? []).filter((c) => c.startTime >= from && c.startTime <= to);
    },
    async listParticipants(conf) {
      calls.push(`parts ${conf}`);
      return data.participants?.[conf] ?? [];
    },
    async listSessions(part) {
      calls.push(`sess ${part}`);
      return data.sessions?.[part] ?? [];
    },
  };
  return { client, calls };
}

// 10-12 (Mon) 21:00–22:00 JST = 12:00–13:00Z. Two conferences (the call was restarted).
const TWO_CONFS = {
  conferences: {
    "abc-defg-hij": [
      { name: "conferenceRecords/c1", startTime: "2026-10-12T11:58:00Z", endTime: "2026-10-12T12:30:00Z" },
      { name: "conferenceRecords/c2", startTime: "2026-10-12T12:32:00Z", endTime: "2026-10-12T13:02:00Z" },
    ],
  },
  participants: {
    "conferenceRecords/c1": [
      p("conferenceRecords/c1/participants/a", { googleUserId: "g1", displayName: "Ichiro Yamada", earliestStartTime: "2026-10-12T12:00:00Z", latestEndTime: "2026-10-12T12:30:00Z" }),
      p("conferenceRecords/c1/participants/b", { googleUserId: "g2", displayName: "佐藤二郎", earliestStartTime: "2026-10-12T12:10:00Z", latestEndTime: "2026-10-12T12:20:00Z" }),
      p("conferenceRecords/c1/participants/x", { kind: "anonymous", displayName: "ゲストさん", earliestStartTime: "2026-10-12T12:05:00Z", latestEndTime: "2026-10-12T12:25:00Z" }),
    ],
    "conferenceRecords/c2": [
      p("conferenceRecords/c2/participants/a", { googleUserId: "g1", displayName: "Ichiro Yamada", earliestStartTime: "2026-10-12T12:32:00Z", latestEndTime: "2026-10-12T13:00:00Z" }),
    ],
  },
  sessions: {
    "conferenceRecords/c1/participants/a": [{ startTime: "2026-10-12T12:00:00Z", endTime: "2026-10-12T12:30:00Z" }],
    "conferenceRecords/c1/participants/b": [{ startTime: "2026-10-12T12:10:00Z", endTime: "2026-10-12T12:20:00Z" }],
    "conferenceRecords/c1/participants/x": [{ startTime: "2026-10-12T12:05:00Z", endTime: "2026-10-12T12:25:00Z" }],
    "conferenceRecords/c2/participants/a": [{ startTime: "2026-10-12T12:32:00Z", endTime: "2026-10-12T13:00:00Z" }],
  },
};

async function setup(now: string, meetData: Parameters<typeof fakeMeet>[0] = TWO_CONFS) {
  const meetings = createInMemoryMeetingStore();
  const store = createInMemoryAttendanceStore();
  await meetings.insertMeeting(row({}));
  await meetings.insertMeeting(row({ id: "dsm_dev", targetId: "role_dev", title: "開発定例", startsAt: "2026-10-07T11:00:00.000Z", meetUrl: "https://meet.google.com/dev-dev-dev" }));
  await meetings.insertMeeting(row({ id: "dsm_once", title: "単発", recurrence: "none", startsAt: "2026-10-12T12:00:00.000Z", meetUrl: "https://meet.google.com/one-once-one" }));
  await store.setRegular(ORG, "dsm_all", true, "usr_admin", now);
  await store.setRegular(ORG, "dsm_dev", true, "usr_admin", now);
  let clock = now;
  const meet = fakeMeet(meetData);
  const svc = buildAttendance({ roster: roster(), meetings, store, now: () => clock, meetRecords: { ready: true, client: meet.client } });
  const ingest = (opts: Partial<Parameters<typeof runMeetIngest>[1]> = {}) =>
    runMeetIngest({ meetings, store, client: meet.client, orgId: ORG, now: () => clock }, { budget: 50, ...opts });
  return { ...svc, meet, ingest, setNow: (n: string) => (clock = n) };
}

const occ = (r: meeting.AttendanceReportResponse, id: string, date: string) => r.meetings.find((m) => m.id === id)!.occurrences.find((o) => o.date === date)!;

describe("pure rules", () => {
  it("openOccurrence: 30 minutes before the start until the end", () => {
    const m = row({});
    expect(openOccurrence(m, "2026-10-12T11:29:00.000Z")).toBeNull();
    expect(openOccurrence(m, "2026-10-12T11:30:00.000Z")?.date).toBe("2026-10-12");
    expect(openOccurrence(m, "2026-10-12T13:00:01.000Z")).toBeNull();
  });

  it("sessionSeconds merges overlapping sessions and ends open ones at the conference end", () => {
    const end = Date.parse("2026-10-12T13:00:00Z");
    expect(
      sessionSeconds(
        [
          { startTime: "2026-10-12T12:00:00Z", endTime: "2026-10-12T12:10:00Z" },
          { startTime: "2026-10-12T12:05:00Z", endTime: "2026-10-12T12:20:00Z" },
          { startTime: "2026-10-12T12:50:00Z", endTime: null },
        ],
        end,
      ),
    ).toBe(30 * 60);
  });

  it("precedence: manual > meet_api (threshold) > join", () => {
    const join = { meetingId: "m", occurrenceDate: "d", userId: "u", orgId: ORG, status: "present" as const, source: "join" as const, joinedAt: "t", recordedBy: "u", updatedAt: "t" };
    const manual = { ...join, status: "excused" as const, source: "manual" as const, recordedBy: "hr" };
    const short = { firstJoin: "a", lastLeave: "b", durationSeconds: 600, approx: false };
    expect(effectiveRecord("u", { manual, join, meet: short }, 1800)).toMatchObject({ status: "excused", source: "manual", joinedAt: "t" });
    expect(effectiveRecord("u", { manual: null, join, meet: short }, 1800)).toMatchObject({ status: "absent", source: "meet_api" });
    expect(effectiveRecord("u", { manual: null, join, meet: { ...short, durationSeconds: 1800 } }, 1800)).toMatchObject({ status: "present", source: "meet_api" });
    expect(effectiveRecord("u", { manual: null, join, meet: null }, 1800)).toMatchObject({ status: "present", source: "join" });
    expect(effectiveRecord("u", { manual: null, join: null, meet: null }, 1800)).toBeNull();
  });

  it("suggestMembers ranks by name likeness", () => {
    const c = USERS.map((u) => ({ id: u.id, name: u.name }));
    expect(suggestMembers("佐藤二郎", c)).toEqual([{ userId: "usr_2", name: "佐藤 二郎" }]);
    expect(suggestMembers("山田", c).map((s) => s.userId)).toEqual(["usr_1"]);
    expect(suggestMembers("Someone Else", c)).toEqual([]);
  });

  it("Meet participant mapping and the conferenceRecords filter", async () => {
    expect(mapParticipant({ name: "conferenceRecords/c/participants/1", earliestStartTime: "t", signedinUser: { user: "users/123", displayName: "A" } })).toMatchObject({
      kind: "signed_in",
      googleUserId: "123",
    });
    expect(mapParticipant({ name: "n", earliestStartTime: "t", phoneUser: { displayName: "電話 1" } })).toMatchObject({ kind: "phone", googleUserId: null });
    expect(mapParticipant({ name: "n", earliestStartTime: "t", anonymousUser: {} })).toMatchObject({ kind: "anonymous", displayName: "ゲスト" });
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (u: string) => {
      urls.push(u);
      return new Response(JSON.stringify({ conferenceRecords: [{ name: "conferenceRecords/c1", startTime: "2026-10-12T12:00:00Z" }] }), { status: 200 });
    });
    const client = createGoogleMeetRecordsClient({ token: { getAccessToken: async () => "at", grantedScopes: async () => null }, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await client.listConferences("abc-defg-hij", "2026-10-12T11:00:00.000Z", "2026-10-12T13:00:00.000Z")).toEqual([
      { name: "conferenceRecords/c1", startTime: "2026-10-12T12:00:00Z", endTime: null },
    ]);
    expect(new URL(urls[0]!).searchParams.get("filter")).toBe(
      'space.meeting_code = "abc-defg-hij" AND start_time >= "2026-10-12T11:00:00.000Z" AND start_time <= "2026-10-12T13:00:00.000Z"',
    );
  });
});

describe("Meet ingest", () => {
  it("reads ended occurrences only, merges one person across restarted conferences, sums sessions", async () => {
    const t = await setup("2026-10-12T13:20:00.000Z");
    const r = await t.ingest();
    expect(r.complete).toBe(true);
    // 10-05 had no conference; 10-12 had two. 10-07 / 10-14 dev 定例: none. 10-19 not yet.
    const rows = [...t.store.participants.values()].filter((x) => x.occurrenceDate === "2026-10-12");
    const g1 = rows.find((x) => x.participantKey === "u:g1")!;
    expect(g1).toMatchObject({ durationSeconds: 58 * 60, firstJoin: "2026-10-12T12:00:00.000Z", lastLeave: "2026-10-12T13:00:00.000Z", approx: false });
    expect(rows.find((x) => x.participantKey === "u:g2")!.durationSeconds).toBe(600);
    expect(rows.find((x) => x.kind === "anonymous")!.participantKey).toBe("conferenceRecords/c1/participants/x");
    expect(t.store.ingests.get("dsm_all|2026-10-12")).toMatchObject({ status: "done", conferences: 2, participants: 3 });
    expect(t.store.ingests.get("dsm_all|2026-10-05")).toMatchObject({ status: "no_conference" });
    expect(t.meet.calls[0]).toBe("conf abc-defg-hij 2026-10-05T11:00:00.000Z 2026-10-05T13:00:00.000Z");
  });

  it("is idempotent and skips settled occurrences unless forced", async () => {
    const t = await setup("2026-10-13T06:00:00.000Z"); // well after 10-12 ended
    await t.ingest();
    const n = t.meet.calls.length;
    await t.ingest();
    expect(t.meet.calls.length).toBe(n); // nothing pending
    await t.ingest({ force: true, from: "2026-10-12", to: "2026-10-12" });
    expect(t.meet.calls.length).toBeGreaterThan(n);
    expect([...t.store.participants.values()].filter((x) => x.occurrenceDate === "2026-10-12")).toHaveLength(3);
  });

  it("re-reads a fresh 'done' occurrence until it settles (late leavers)", async () => {
    const t = await setup("2026-10-12T13:20:00.000Z");
    await t.ingest();
    const before = t.meet.calls.length;
    t.setNow("2026-10-12T14:00:00.000Z");
    await t.ingest();
    expect(t.meet.calls.slice(before).some((c) => c.includes("2026-10-12T11:00"))).toBe(true);
  });

  it("falls back to first join → last leave when the budget runs low, and stops when it runs out", async () => {
    const t = await setup("2026-10-12T13:20:00.000Z");
    // conf list (1) + c1 participants (1), then nothing left for c2 -> cut short, nothing written.
    const r = await t.ingest({ budget: 2, from: "2026-10-12", to: "2026-10-12" });
    expect(r.complete).toBe(false);
    expect(t.store.ingests.size).toBe(0);
    // conf (1) + c1 (1) + sessions of a, b (2) + c2 (1): x and c2/a fall back to their span.
    const t2 = await setup("2026-10-12T13:20:00.000Z");
    const r2 = await t2.ingest({ budget: 5, from: "2026-10-12", to: "2026-10-12" });
    expect(r2.complete).toBe(true);
    expect([...t2.store.participants.values()].some((x) => x.approx)).toBe(true);
  });

  it("records an error and retries next run", async () => {
    const t = await setup("2026-10-12T13:20:00.000Z", { fail: true });
    await t.ingest({ from: "2026-10-12", to: "2026-10-12" });
    expect(t.store.ingests.get("dsm_all|2026-10-12")).toMatchObject({ status: "error", attempts: 1, lastError: "google 500" });
    await t.ingest({ from: "2026-10-12", to: "2026-10-12" });
    expect(t.store.ingests.get("dsm_all|2026-10-12")!.attempts).toBe(2);
  });

  it("only looks back within Google's retention (29 days)", async () => {
    const t = await setup("2026-12-01T00:00:00.000Z");
    const c = await ingestCandidates({ meetings: t.meetings, store: t.store, orgId: ORG }, Date.parse("2026-12-01T00:00:00.000Z"), {});
    expect(c.every((x) => x.date >= "2026-11-02")).toBe(true);
    expect(c.length).toBeGreaterThan(0);
  });

  it("manual 今すぐ取り込む: skipped without the scope; a cut-short run kicks the job", async () => {
    const t = await setup("2026-10-12T13:20:00.000Z");
    const noScope = buildAttendance({ roster: roster(), meetings: t.meetings, store: t.store, meetRecords: { ready: false, client: t.meet.client } });
    expect(await noScope.service.ingest({})).toMatchObject({ skipped: "scope_missing", occurrences: 0 });
    const r = await t.service.ingest({});
    expect(r).toMatchObject({ skipped: null, complete: true });
    expect(r.occurrences).toBeGreaterThan(0);
    await expect(t.service.ingest({ from: "nope" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("report (Meet attendance)", () => {
  it("matched participants count by duration vs the threshold; unmatched show suggestions; confirm remembers", async () => {
    const t = await setup("2026-10-12T13:20:00.000Z");
    await t.ingest();
    await t.store.putLink({ orgId: ORG, googleUserId: "g1", userId: "usr_1", source: "self", linkedBy: "usr_1", linkedAt: "x" });

    let r = await t.service.report({ from: "2026-10-01", to: "2026-10-31" });
    expect(r.settings.minPercent).toBe(50);
    expect(r.meetApi.ready).toBe(true);
    let o = occ(r, "dsm_all", "2026-10-12");
    expect(o.ingest).toMatchObject({ status: "done" });
    expect(o.records.find((x) => x.userId === "usr_1")).toMatchObject({ status: "present", source: "meet_api", meet: { durationSeconds: 3480 } });
    const g2 = o.participants.find((x) => x.googleUserId === "g2")!;
    expect(g2).toMatchObject({ userId: null, suggestions: [{ userId: "usr_2", name: "佐藤 二郎" }] });
    expect(o.participants.find((x) => x.kind === "anonymous")).toMatchObject({ userId: null, suggestions: [] });

    // 人事 confirms g2 = usr_2 once: matched from now on (10 min < 30 min threshold → absent).
    await t.service.confirm("usr_hr", "g2", { userId: "usr_2" });
    r = await t.service.report({ from: "2026-10-01", to: "2026-10-31" });
    o = occ(r, "dsm_all", "2026-10-12");
    expect(o.records.find((x) => x.userId === "usr_2")).toMatchObject({ status: "absent", source: "meet_api" });
    expect(t.store.links.get(`${ORG}|g2`)).toMatchObject({ userId: "usr_2", source: "confirmed", linkedBy: "usr_hr" });

    // Lower the threshold to 10%: now present.
    expect(await t.service.updateSettings("usr_hr", { minPercent: 10 })).toEqual({ minPercent: 10 });
    r = await t.service.report({ from: "2026-10-01", to: "2026-10-31" });
    expect(occ(r, "dsm_all", "2026-10-12").records.find((x) => x.userId === "usr_2")!.status).toBe("present");
    await expect(t.service.updateSettings("usr_hr", { minPercent: 0 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    // Unlink: back to 未確定.
    await t.service.unlink("g2");
    r = await t.service.report({ from: "2026-10-01", to: "2026-10-31" });
    expect(occ(r, "dsm_all", "2026-10-12").participants.find((x) => x.googleUserId === "g2")!.userId).toBeNull();
    await expect(t.service.confirm("usr_hr", "g2", { userId: "usr_nobody" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("manual wins over Meet; absent can be set by hand; null returns to automatic", async () => {
    const t = await setup("2026-10-12T13:20:00.000Z");
    await t.ingest();
    await t.store.putLink({ orgId: ORG, googleUserId: "g1", userId: "usr_1", source: "self", linkedBy: "usr_1", linkedAt: "x" });
    const set = await t.service.set("usr_hr", "dsm_all", "2026-10-12", "usr_1", { status: "absent" });
    expect(set.record).toMatchObject({ status: "absent", source: "manual", recordedBy: "usr_hr" });
    let r = await t.service.report({ from: "2026-10-01", to: "2026-10-31" });
    expect(occ(r, "dsm_all", "2026-10-12").records.find((x) => x.userId === "usr_1")).toMatchObject({ status: "absent", source: "manual", meet: { durationSeconds: 3480 } });
    await t.service.set("usr_hr", "dsm_all", "2026-10-12", "usr_1", { status: null });
    r = await t.service.report({ from: "2026-10-01", to: "2026-10-31" });
    expect(occ(r, "dsm_all", "2026-10-12").records.find((x) => x.userId === "usr_1")!.source).toBe("meet_api");
    await expect(t.service.set("usr_hr", "dsm_all", "2026-10-13", "usr_1", { status: "present" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(t.service.set("usr_hr", "dsm_dev", "2026-10-07", "usr_3", { status: "present" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("a Dub join counts when Meet has nothing matched for the member; rates per member", async () => {
    const t = await setup("2026-10-12T12:05:00.000Z");
    expect(await t.service.join("usr_3", "dsm_all")).toEqual({ meetUrl: MEET, recordedFor: "2026-10-12" });
    t.setNow("2026-10-12T13:20:00.000Z");
    await t.ingest();
    await t.store.putLink({ orgId: ORG, googleUserId: "g1", userId: "usr_1", source: "self", linkedBy: "usr_1", linkedAt: "x" });
    const r = await t.service.report({ from: "2026-10-01", to: "2026-10-31" });
    const o = occ(r, "dsm_all", "2026-10-12");
    expect(o.records.find((x) => x.userId === "usr_3")).toMatchObject({ status: "present", source: "join" });
    const by = Object.fromEntries(r.members.map((m) => [m.userId, m]));
    // dsm_all: 10-05, 10-12; dsm_dev: 10-07 (10-14 not started).
    expect(by.usr_1).toMatchObject({ expected: 3, present: 1 });
    expect(by.usr_3).toMatchObject({ expected: 2, present: 1, rate: 0.5 });
    expect(r.meetings.some((m) => m.id === "dsm_once")).toBe(false);
  });

  it("join: outside the window / not a 定例 records nothing; a non-member is refused", async () => {
    const t = await setup("2026-10-12T09:00:00.000Z");
    expect((await t.service.join("usr_1", "dsm_all")).recordedFor).toBeNull();
    t.setNow("2026-10-12T12:05:00.000Z");
    expect((await t.service.join("usr_1", "dsm_once")).recordedFor).toBeNull();
    t.setNow("2026-10-14T11:05:00.000Z");
    await expect(t.service.join("usr_3", "dsm_dev")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(t.store.records.size).toBe(0);
  });

  it("myRegulars lists the caller's 定例 and whether Google is linked", async () => {
    const t = await setup("2026-10-12T12:05:00.000Z");
    await t.service.join("usr_1", "dsm_all");
    let mine = await t.service.myRegulars("usr_1");
    expect(mine.googleLinked).toBe(false);
    expect(mine.items.map((i) => [i.id, i.joinOpen, i.attended])).toEqual([
      ["dsm_all", true, true],
      ["dsm_dev", false, false],
    ]);
    await t.store.putLink({ orgId: ORG, googleUserId: "g1", userId: "usr_1", source: "self", linkedBy: "usr_1", linkedAt: "x" });
    mine = await t.service.myRegulars("usr_1");
    expect(mine.googleLinked).toBe(true);
  });

  it("validates the report range", async () => {
    const t = await setup("2026-10-12T12:05:00.000Z");
    expect([(await t.service.report({})).from, (await t.service.report({})).to]).toEqual(["2026-07-21", "2026-10-12"]);
    await expect(t.service.report({ from: "2026-13-01" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(t.service.report({ from: "2026-10-10", to: "2026-10-01" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("Googleと連携", () => {
  const WEB = { GOOGLE_HACKIT_OAUTH_WEB_CLIENT_ID: "web-id", GOOGLE_HACKIT_OAUTH_WEB_CLIENT_SECRET: "web-secret" } as unknown as Env;
  const idToken = (sub: string) => `h.${btoa(JSON.stringify({ sub })).replace(/=+$/, "")}.s`;

  it("openid-only round-trip stores the caller's Google account id", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id_token: idToken("1234567890") }), { status: 200 }));
    const { service, attendance } = buildGoogleLink({ env: WEB, fetchImpl: fetchImpl as unknown as typeof fetch });
    const { authUrl } = await service.start("usr_1", { redirectUri: "https://app.example/driveshare" });
    const u = new URL(authUrl);
    expect(u.searchParams.get("scope")).toBe("openid");
    const state = u.searchParams.get("state")!;
    expect(state.startsWith(meeting.GOOGLE_LINK_STATE_PREFIX)).toBe(true);
    await expect(service.complete("usr_2", { code: "c", state })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { authUrl: again } = await service.start("usr_1", { redirectUri: "https://app.example/driveshare" });
    expect(await service.complete("usr_1", { code: "c", state: new URL(again).searchParams.get("state")! })).toEqual({ googleLinked: true });
    expect(attendance.links.get(`${ORG}|1234567890`)).toMatchObject({ userId: "usr_1", source: "self" });
  });

  it("refuses other redirect targets, missing client, and the account-connect flow refuses link states", async () => {
    await expect(buildGoogleLink({ env: WEB }).service.start("u", { redirectUri: "https://evil.example/x" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(buildGoogleLink().service.start("u", { redirectUri: "https://app.example/driveshare" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(stubGoogleAccount().completeConnect("u", { code: "c", state: "lnk_abc" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(subOfIdToken(idToken("42"))).toBe("42");
    expect(subOfIdToken("garbage")).toBeNull();
  });
});

describe("trackAttendance on meetings", () => {
  const BASE = { title: "開発定例", targetId: "role_dev", startsAt: "2026-10-20T10:00:00.000Z", durationMinutes: 60, recurrence: "weekly" };

  it("create / update / list carry the flag", async () => {
    const { service, attendance } = buildMeetings({ roster: roster() });
    const m = await service.create("usr_admin", { ...BASE, trackAttendance: true });
    expect(m.trackAttendance).toBe(true);
    expect(attendance.regulars.has(m.id)).toBe(true);
    expect((await service.update(m.id, { trackAttendance: false }, "usr_admin")).trackAttendance).toBe(false);
    await expect(service.create("usr_admin", { ...BASE, trackAttendance: "yes" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("HTTP surface", () => {
  async function appWith(...keys: Parameters<typeof memAuthzHolding>) {
    const t = await setup("2026-10-12T13:20:00.000Z");
    const client = createMockDriveShareClient();
    const { service: roleGrants } = buildRoleGrants({ drive: client, roster: fakeRoster({}) });
    const app = createApp({
      service: createDriveShareService({ client, config: { listPageSize: 50 } }),
      roleGrants,
      authz: memAuthzHolding(...keys),
      googleAccount: stubGoogleAccount(),
      meetings: async () => buildMeetings().service,
      attendance: () => t.service,
      googleLink: () => buildGoogleLink().service,
    });
    return { app, t };
  }
  const JSON_HDR = { ...AUTHED, "content-type": "application/json" };

  it("人事 閲覧 reads; ingest / confirm / settings / corrections need 人事 編集 + hr:write", async () => {
    const viewer = await appWith("app:hr:view", "hr:read");
    expect((await viewer.app.request("/meetings/attendance?from=2026-10-01&to=2026-10-31", { headers: AUTHED })).status).toBe(200);
    expect((await viewer.app.request("/meetings/attendance/ingest", { method: "POST", headers: AUTHED })).status).toBe(403);
    const editor = await appWith("app:hr:view", "app:hr:edit", "hr:read", "hr:write");
    const ing = await editor.app.request("/meetings/attendance/ingest", { method: "POST", headers: AUTHED });
    expect(ing.status).toBe(200);
    expect(((await ing.json()) as meeting.IngestAttendanceResponse).occurrences).toBeGreaterThan(0);
    const conf = await editor.app.request("/meetings/attendance/links/g2", { method: "PUT", headers: JSON_HDR, body: JSON.stringify({ userId: "usr_2" }) });
    expect(conf.status).toBe(200);
    const set = await editor.app.request("/meetings/attendance/settings", { method: "PUT", headers: JSON_HDR, body: JSON.stringify({ minPercent: 70 }) });
    expect(await set.json()).toEqual({ minPercent: 70 });
    expect((await editor.app.request("/meetings/attendance/links/g2", { method: "DELETE", headers: AUTHED })).status).toBe(200);
  });

  it("any signed-in member joins, lists their 定例 and starts 「Googleと連携」", async () => {
    const { app } = await appWith();
    expect((await app.request("/meetings/me/regulars", { headers: AUTHED })).status).toBe(200);
    // No web client configured in this env -> 409 from the service (not 403 from the gate).
    const start = await app.request("/meetings/me/google-link/start", { method: "POST", headers: JSON_HDR, body: JSON.stringify({ redirectUri: "https://app.example/driveshare" }) });
    expect(start.status).toBe(409);
    expect((await app.request("/meetings/attendance", { headers: AUTHED })).status).toBe(403);
  });
});
