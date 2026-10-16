// カレンダー > ミーティング: rules (RRULE / validation), create / update / delete over the mock and
// the real (fetch-faked) Calendar client, reconcile that only ever removes what we added, the
// calendar-scope gate, and the alarm scheduling rule.
import { describe, it, expect } from "vitest";
import { CommonErrorCodes } from "@dub/errors";
import { createApp } from "../src/app";
import { createDriveShareService } from "../src/service";
import { createMockDriveShareClient } from "../src/mock-client";
import { createGoogleCalendarClient } from "../src/google/calendar-client";
import { createTokenProvider } from "../src/google/token";
import { createMockCalendarClient } from "../src/calendar-mock-client";
import { staticMemberDirectory } from "../src/member-directory";
import { fromRecurrence, jstDate, toRecurrence, validateMeeting } from "../src/meeting-rules";
import { eventIdFor } from "../src/meetings-service";
import { nextAlarmAt } from "../src/meeting-sync-do";
import { resolveMeetingAccount } from "../src/meetings-wiring";
import type { ActiveUser } from "../src/role-membership";
import type { Env } from "../src/env";
import { AUTHED, buildMeetings, buildRoleGrants, fakeRoster, memAuthzHolding, stubGoogleAccount } from "./helpers";

const USERS: ActiveUser[] = [
  { id: "usr_a", email: "a@dub.example", name: "A", roleIds: ["role_dev"] },
  { id: "usr_b", email: "b@dub.example", name: "B", roleIds: ["role_dev", "role_pr"] },
  { id: "usr_c", email: "c@dub.example", name: "C", roleIds: ["role_pr"] },
];
const NAMES = { role_dev: "開発", role_pr: "広報" };
const GMAIL = staticMemberDirectory({
  usr_a: { gmail: "a.gmail@gmail.com", name: "A" },
  usr_b: { gmail: null, name: "B" },
});

function roster(users = USERS) {
  return fakeRoster({}, NAMES, users);
}

const BASE = {
  title: "開発定例",
  targetId: "role_dev",
  startsAt: "2026-10-20T10:00:00.000Z", // 火 19:00 JST
  durationMinutes: 60,
  recurrence: "weekly",
};

describe("toRecurrence (RRULE)", () => {
  it("none -> no rule; weekly / biweekly", () => {
    expect(toRecurrence({ startsAt: BASE.startsAt, recurrence: "none", until: null })).toEqual([]);
    expect(toRecurrence({ startsAt: BASE.startsAt, recurrence: "weekly", until: null })).toEqual(["RRULE:FREQ=WEEKLY"]);
    expect(toRecurrence({ startsAt: BASE.startsAt, recurrence: "biweekly", until: null })).toEqual(["RRULE:FREQ=WEEKLY;INTERVAL=2"]);
  });

  it("monthly_weekday takes 第N X曜日 from the first occurrence in JST", () => {
    // 2026-10-20 is the 3rd Tuesday.
    expect(toRecurrence({ startsAt: BASE.startsAt, recurrence: "monthly_weekday", until: null })).toEqual(["RRULE:FREQ=MONTHLY;BYDAY=3TU"]);
    // 2026-10-31T15:30Z is Sun 2026-11-01 00:30 JST -> 1st Sunday (not Saturday in UTC).
    expect(toRecurrence({ startsAt: "2026-10-31T15:30:00.000Z", recurrence: "monthly_weekday", until: null })).toEqual(["RRULE:FREQ=MONTHLY;BYDAY=1SU"]);
  });

  it("a 5th weekday means the last one (-1)", () => {
    // 2026-10-29 is the 5th Thursday of October.
    expect(toRecurrence({ startsAt: "2026-10-29T01:00:00.000Z", recurrence: "monthly_weekday", until: null })).toEqual(["RRULE:FREQ=MONTHLY;BYDAY=-1TH"]);
  });

  it("until = the last instant of that JST day, in UTC", () => {
    expect(toRecurrence({ startsAt: BASE.startsAt, recurrence: "weekly", until: "2027-03-31" })).toEqual(["RRULE:FREQ=WEEKLY;UNTIL=20270331T145959Z"]);
  });
});

describe("validateMeeting", () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as { code: string; message: string }).message;
    }
    return null;
  };

  it("normalises a valid body (one-off drops until)", () => {
    const f = validateMeeting({ ...BASE, title: "  開発定例 ", recurrence: "none", until: "2027-01-01", startsAt: "2026-10-20T19:00:00+09:00" });
    expect(f).toMatchObject({ title: "開発定例", startsAt: "2026-10-20T10:00:00.000Z", until: null, description: null });
  });

  it("rejects bad title / duration / start / recurrence / until with Japanese messages", () => {
    expect(code(() => validateMeeting({ ...BASE, title: "" }))).toMatch(/タイトル/);
    expect(code(() => validateMeeting({ ...BASE, title: "x".repeat(201) }))).toMatch(/タイトル/);
    expect(code(() => validateMeeting({ ...BASE, durationMinutes: 4 }))).toMatch(/所要時間/);
    expect(code(() => validateMeeting({ ...BASE, durationMinutes: 721 }))).toMatch(/所要時間/);
    expect(code(() => validateMeeting({ ...BASE, startsAt: "not a date" }))).toMatch(/開始日時/);
    expect(code(() => validateMeeting({ ...BASE, recurrence: "daily" }))).toMatch(/繰り返し/);
    expect(code(() => validateMeeting({ ...BASE, until: "2026-10-19" }))).toMatch(/終了日は初回/);
    expect(code(() => validateMeeting({ ...BASE, until: "2026-13-01" }))).toMatch(/終了日の形式/);
    expect(code(() => validateMeeting({ ...BASE, targetId: "" }))).toMatch(/対象/);
  });

  it("until on the first day itself is allowed (JST date of the start)", () => {
    expect(jstDate("2026-10-20T16:00:00.000Z")).toBe("2026-10-21");
    expect(validateMeeting({ ...BASE, startsAt: "2026-10-20T16:00:00.000Z", until: "2026-10-21" }).until).toBe("2026-10-21");
  });

  it("an update merges over the stored fields", () => {
    const stored = validateMeeting(BASE);
    expect(validateMeeting({ title: "改名" }, stored)).toMatchObject({ ...stored, title: "改名" });
  });
});

describe("create", () => {
  it("creates the target calendar lazily, invites members at 名簿 Gmail else Dub address; the kicked sync shares it with everyone", async () => {
    const { service, store, calendar, kicks } = buildMeetings({ roster: roster(), directory: GMAIL });
    const m = await service.create("usr_admin", BASE);
    expect(m).toMatchObject({ title: "開発定例", targetId: "role_dev", targetName: "開発", attendeeCount: 2, recurrence: "weekly" });
    expect(m.meetUrl).toMatch(/^https:\/\/meet\.google\.com\//);

    const mock = calendar as ReturnType<typeof createMockCalendarClient>;
    const [calId, cal] = [...mock.state.calendars.entries()][0]!;
    expect(cal.summary).toBe("開発");
    const ev = [...cal.events.values()][0]!;
    expect(ev.attendees.map((a) => a.email).sort()).toEqual(["a.gmail@gmail.com", "b@dub.example"]);
    expect(ev.recurrence).toEqual(["RRULE:FREQ=WEEKLY"]);
    expect(ev.timeZone).toBe("Asia/Tokyo");
    // sharing is one Google call per member: not in the request (gateway 15 s), the kicked sync does it
    expect(cal.acl.filter((r) => r.role === "reader")).toEqual([]);
    expect(kicks).toEqual([60_000]);
    await service.sync();
    // shared read-only with every active member (not only the role)
    expect(cal.acl.filter((r) => r.role === "reader").map((r) => r.email).sort()).toEqual(["a.gmail@gmail.com", "b@dub.example", "c@dub.example"]);
    expect((await store.listAcl("org_devhub", calId)).length).toBe(3);

    // a second meeting for the same target reuses the calendar
    await service.create("usr_admin", { ...BASE, title: "別の会" });
    expect(mock.state.calendars.size).toBe(1);
  });

  it("全体 targets every active member and its calendar is named 全体", async () => {
    const { service, calendar } = buildMeetings({ roster: roster() });
    const m = await service.create("usr_admin", { ...BASE, targetId: "all" });
    expect(m).toMatchObject({ targetName: "全体", attendeeCount: 3 });
    const cal = [...(calendar as ReturnType<typeof createMockCalendarClient>).state.calendars.values()][0]!;
    expect(cal.summary).toBe("全体");
  });

  it("an unknown role is a 400", async () => {
    const { service } = buildMeetings({ roster: roster() });
    await expect(service.create("usr_admin", { ...BASE, targetId: "role_gone" })).rejects.toMatchObject({ code: CommonErrorCodes.VALIDATION_FAILED });
  });

  it("sends a Meet createRequest (conferenceDataVersion=1, sendUpdates=all) and the attendees to Google", async () => {
    const calls: { url: string; method: string; body: any }[] = [];
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url: String(input), method: init?.method ?? "GET", body });
      const u = new URL(String(input));
      if (u.pathname.endsWith("/calendars")) return Response.json({ id: "cal_dev@group.calendar.google.com" });
      if (u.pathname.endsWith("/events")) return Response.json({ id: "evt_1", htmlLink: "https://calendar.google.com/e/1", hangoutLink: "https://meet.google.com/abc-defg-hij", attendees: body.attendees });
      if (u.pathname.endsWith("/acl") && init?.method === "GET") return Response.json({ items: [{ id: "user:hackit@gmail.com", role: "owner", scope: { type: "user", value: "hackit@gmail.com" } }] });
      if (u.pathname.endsWith("/acl")) return Response.json({ id: `user:${body.scope.value}` });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const token = { getAccessToken: async () => "tok", grantedScopes: async () => null };
    const calendar = createGoogleCalendarClient({ token, fetchImpl, newRequestId: () => "req-fixed" });
    const { service } = buildMeetings({ roster: roster(), directory: GMAIL, calendar });

    const m = await service.create("usr_admin", { ...BASE, description: "議題は前日まで", until: "2027-03-31" });
    expect(m.meetUrl).toBe("https://meet.google.com/abc-defg-hij");

    const insert = calls.find((c) => c.method === "POST" && new URL(c.url).pathname.endsWith("/events"))!;
    const q = new URL(insert.url).searchParams;
    expect(q.get("conferenceDataVersion")).toBe("1");
    expect(q.get("sendUpdates")).toBe("all");
    expect(insert.body).toMatchObject({
      summary: "開発定例",
      description: "議題は前日まで",
      start: { dateTime: "2026-10-20T10:00:00.000Z", timeZone: "Asia/Tokyo" },
      end: { dateTime: "2026-10-20T11:00:00.000Z", timeZone: "Asia/Tokyo" },
      recurrence: ["RRULE:FREQ=WEEKLY;UNTIL=20270331T145959Z"],
      conferenceData: { createRequest: { requestId: "req-fixed", conferenceSolutionKey: { type: "hangoutsMeet" } } },
    });
    expect(insert.body.attendees.map((a: { email: string }) => a.email).sort()).toEqual(["a.gmail@gmail.com", "b@dub.example"]);
    const created = calls.find((c) => new URL(c.url).pathname.endsWith("/calendars"))!;
    expect(created.body).toEqual({ summary: "開発", timeZone: "Asia/Tokyo" });
  });
});

describe("update / delete", () => {
  it("patches the event; moving the target recreates it on the other calendar", async () => {
    const { service, calendar } = buildMeetings({ roster: roster() });
    const mock = calendar as ReturnType<typeof createMockCalendarClient>;
    const m = await service.create("usr_admin", BASE);
    const renamed = await service.update(m.id, { title: "開発定例（拡大）", durationMinutes: 90 });
    expect(renamed).toMatchObject({ title: "開発定例（拡大）", durationMinutes: 90, attendeeCount: 2 });
    const ev = [...[...mock.state.calendars.values()][0]!.events.values()][0]!;
    expect(ev.summary).toBe("開発定例（拡大）");
    expect(ev.end).toBe("2026-10-20T11:30:00.000Z");

    const moved = await service.update(m.id, { targetId: "role_pr" });
    expect(moved).toMatchObject({ targetId: "role_pr", targetName: "広報", attendeeCount: 2 });
    const cals = [...mock.state.calendars.values()];
    expect(cals.map((c) => c.summary)).toEqual(["開発", "広報"]);
    expect(cals[0]!.events.size).toBe(0);
    expect([...cals[1]!.events.values()][0]!.attendees.map((a) => a.email).sort()).toEqual(["b@dub.example", "c@dub.example"]);
  });

  it("delete removes the Google event and the row (404 on the next delete)", async () => {
    const { service, calendar, store } = buildMeetings({ roster: roster() });
    const m = await service.create("usr_admin", BASE);
    await service.remove(m.id);
    expect([...(calendar as ReturnType<typeof createMockCalendarClient>).state.calendars.values()][0]!.events.size).toBe(0);
    expect(store.meetings.size).toBe(0);
    await expect(service.remove(m.id)).rejects.toMatchObject({ code: CommonErrorCodes.NOT_FOUND });
  });
});

describe("reconcile (sync)", () => {
  it("adds new role members and removes departed ones it invited — never a hand-added guest or share", async () => {
    let users = USERS;
    const dynamicRoster = { ...roster(), listActiveUsers: async (roleId?: string) => users.filter((u) => !roleId || u.roleIds.includes(roleId)) };
    const { service, calendar, store } = buildMeetings({ roster: dynamicRoster });
    const mock = calendar as ReturnType<typeof createMockCalendarClient>;
    const m = await service.create("usr_admin", BASE);
    const [calId, cal] = [...mock.state.calendars.entries()][0]!;
    const ev = [...cal.events.values()][0]!;

    // Someone adds a guest and shares the calendar by hand in Google Calendar.
    ev.attendees.push({ email: "guest@example.com", responseStatus: "accepted" });
    await calendar.insertAcl(calId, "friend@example.com");

    // usr_a leaves 開発 (and Dub entirely); usr_c joins 開発.
    users = [
      { id: "usr_b", email: "b@dub.example", name: "B", roleIds: ["role_dev", "role_pr"] },
      { id: "usr_c", email: "c@dub.example", name: "C", roleIds: ["role_pr", "role_dev"] },
    ];
    const r = await service.sync();
    expect(r).toMatchObject({ meetings: 1, invitedAdded: 1, invitedRemoved: 1, complete: true });
    expect(r.withoutGoogleAccount.map((w) => w.userId).sort()).toEqual(["usr_b", "usr_c"]);

    const after = [...cal.events.values()][0]!;
    expect(after.attendees.map((a) => a.email).sort()).toEqual(["b@dub.example", "c@dub.example", "guest@example.com"]);
    expect(after.attendees.find((a) => a.email === "guest@example.com")).toMatchObject({ responseStatus: "accepted" });
    expect((await store.listInvites(m.id)).map((i) => i.email)).toEqual(["b@dub.example", "c@dub.example"]);
    expect(cal.acl.map((a) => a.email).sort()).toEqual(["b@dub.example", "c@dub.example", "friend@example.com", "owner@mock"]);

    // nothing changed -> no patch, same result
    const again = await service.sync();
    expect(again).toMatchObject({ invitedAdded: 0, invitedRemoved: 0 });
  });

  it("never mass-uninvites on an empty target", async () => {
    let users = USERS;
    const dynamicRoster = { ...roster(), listActiveUsers: async () => users };
    const { service, store } = buildMeetings({ roster: dynamicRoster });
    const m = await service.create("usr_admin", BASE);
    users = [];
    const r = await service.sync();
    expect(r.invitedRemoved).toBe(0);
    expect((await store.listInvites(m.id)).length).toBe(2);
  });

  it("stops at the Google call budget and reports incomplete (the alarm continues)", async () => {
    const { service } = buildMeetings({ roster: roster(), googleBudget: 2 });
    await expect(service.create("usr_admin", BASE)).resolves.toBeTruthy(); // calendar + event fit; sharing deferred
    const r = await service.sync();
    expect(r.complete).toBe(false);
  });

  it("stops at the time limit too, so a request-path sync answers before the gateway's 15 s", async () => {
    const base = createMockCalendarClient();
    const slow = { ...base, getEvent: async (c: string, e: string) => {
      await new Promise((r) => setTimeout(r, 30));
      return base.getEvent(c, e);
    } };
    const { service, kicks } = buildMeetings({ roster: roster(), calendar: slow, syncTimeLimitMs: 10 });
    await service.create("usr_admin", BASE);
    await service.create("usr_admin", { ...BASE, title: "別の会" });
    const r = await service.sync();
    expect(r).toMatchObject({ meetings: 1, complete: false });
    expect(kicks.at(-1)).toBe(60_000);
  });

  it("a complete sync only keeps the hourly loop alive; an incomplete one asks for a minute", async () => {
    const full = buildMeetings({ roster: roster() });
    await full.service.sync();
    expect(full.kicks).toEqual([undefined]);
    const cut = buildMeetings({ roster: roster(), googleBudget: 2 });
    await cut.service.create("usr_admin", BASE);
    await cut.service.sync();
    expect(cut.kicks).toEqual([60_000, 60_000]);
  });

  it("an address Google refuses to share with does not block the others", async () => {
    const base = createMockCalendarClient();
    const calendar = { ...base, insertAcl: async (c: string, e: string) => {
      if (e === "a@dub.example") throw new Error("invalid");
      return base.insertAcl(c, e);
    } };
    const { service } = buildMeetings({ roster: roster(), calendar });
    await service.create("usr_admin", BASE);
    await service.sync();
    const cal = [...base.state.calendars.values()][0]!;
    expect(cal.acl.filter((r) => r.role === "reader").map((r) => r.email).sort()).toEqual(["b@dub.example", "c@dub.example"]);
  });
});

describe("Google Calendar is the source of truth", () => {
  type Mock = ReturnType<typeof createMockCalendarClient>;
  const eventOf = (calendar: unknown) => {
    const cal = [...(calendar as Mock).state.calendars.values()][0]!;
    return [...cal.events.values()][0]!;
  };

  it("fromRecurrence reads back every rule toRecurrence writes, and refuses others", () => {
    for (const recurrence of ["none", "weekly", "biweekly", "monthly_weekday"] as const) {
      for (const until of recurrence === "none" ? [null] : [null, "2027-03-31"]) {
        expect(fromRecurrence(toRecurrence({ startsAt: BASE.startsAt, recurrence, until }))).toEqual({ recurrence, until });
      }
    }
    expect(fromRecurrence(["RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261026T095959Z"])).toEqual({ recurrence: "weekly", until: "2026-10-26" });
    // Google's UI: UNTIL = next JST midnight
    expect(fromRecurrence(["RRULE:FREQ=WEEKLY;UNTIL=20261026T150000Z"])).toEqual({ recurrence: "weekly", until: "2026-10-26" });
    expect(fromRecurrence(["RRULE:FREQ=DAILY"])).toBeNull();
    expect(fromRecurrence(["RRULE:FREQ=WEEKLY;BYDAY=MO,TU"])).toBeNull();
    expect(fromRecurrence(["RRULE:FREQ=WEEKLY", "EXDATE:20261027T100000Z"])).toBeNull();
  });

  it("the event id is derived from the meeting id (valid base32hex, stable)", () => {
    expect(eventIdFor("dsm_01M4ZFHQ742WZSWX90EHQVF6MS")).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(eventIdFor("dsm_x")).toBe(eventIdFor("dsm_x"));
  });

  it("create stores the row under the derived event id; a failed insert leaves neither", async () => {
    const ok = buildMeetings({ roster: roster() });
    const m = await ok.service.create("usr_admin", BASE);
    expect(ok.store.meetings.get(m.id)).toMatchObject({ googleEventId: eventIdFor(m.id) });
    expect(ok.store.meetings.get(m.id)!.syncedAt).not.toBeNull();
    expect(eventOf(ok.calendar).id).toBe(eventIdFor(m.id));

    const base = createMockCalendarClient();
    const calendar = { ...base, insertEvent: async () => {
      throw new Error("google down");
    } };
    const bad = buildMeetings({ roster: roster(), calendar });
    await expect(bad.service.create("usr_admin", BASE)).rejects.toThrow("google down");
    expect(bad.store.meetings.size).toBe(0);
  });

  it("a create cut off before its event existed is finished by the sync (no orphan either way)", async () => {
    // Like Google (unlike the tolerant mock): an id never inserted reads back as gone.
    const base = createMockCalendarClient();
    const calendar = { ...base, getEvent: async (c: string, e: string) => (base.state.calendars.get(c)?.events.has(e) ? base.getEvent(c, e) : null) };
    const { service, store } = buildMeetings({ roster: roster(), calendar });
    const m = await service.create("usr_admin", BASE);
    // Simulate the request dying after the D1 row: no event, syncedAt still null.
    const row = store.meetings.get(m.id)!;
    base.state.calendars.get(row.calendarId)!.events.clear();
    store.meetings.set(m.id, { ...row, syncedAt: null, meetUrl: null });

    await service.sync();
    const ev = eventOf(base);
    expect(ev.id).toBe(row.googleEventId);
    expect(ev.summary).toBe("開発定例");
    expect(store.meetings.get(m.id)).toMatchObject({ meetUrl: ev.meetUrl });
    expect(store.meetings.get(m.id)!.syncedAt).not.toBeNull();
  });

  it("an event deleted in Google Calendar removes the meeting from Dub", async () => {
    const { service, calendar, store } = buildMeetings({ roster: roster() });
    const keep = await service.create("usr_admin", BASE);
    const gone = await service.create("usr_admin", { ...BASE, title: "消される会" });
    const row = store.meetings.get(gone.id)!;
    await calendar.deleteEvent(row.calendarId, row.googleEventId); // by hand, in Google Calendar

    await service.sync();
    expect([...store.meetings.keys()]).toEqual([keep.id]);
    expect(await store.listInvites(gone.id)).toEqual([]);
    expect((await service.list()).items.map((i) => i.id)).toEqual([keep.id]);
  });

  it("an unreachable calendar (lost grant / other account) never removes meetings", async () => {
    const base = createMockCalendarClient();
    let reachable = true;
    const calendar = {
      ...base,
      getEvent: async (c: string, e: string) => (reachable ? base.getEvent(c, e) : null),
      listAcl: async (c: string) => {
        if (!reachable) throw new Error("404 calendar");
        return base.listAcl(c);
      },
    };
    const { service, store } = buildMeetings({ roster: roster(), calendar });
    await service.create("usr_admin", BASE);
    reachable = false;
    await service.sync();
    expect(store.meetings.size).toBe(1);
  });

  it("edits made in Google Calendar (title / time / length / repeat) are pulled into Dub", async () => {
    const { service, calendar, store } = buildMeetings({ roster: roster() });
    const m = await service.create("usr_admin", BASE);
    const ev = eventOf(calendar);
    Object.assign(ev, {
      summary: "開発定例（時間変更）",
      start: "2026-10-21T11:00:00+09:00",
      end: "2026-10-21T12:30:00+09:00",
      recurrence: ["RRULE:FREQ=WEEKLY;INTERVAL=2"],
    });
    await service.sync();
    expect(store.meetings.get(m.id)).toMatchObject({
      title: "開発定例（時間変更）",
      startsAt: "2026-10-21T02:00:00.000Z",
      durationMinutes: 90,
      recurrence: "biweekly",
      until: null,
    });
  });

  it("listing pulls the sync close, unless one ran within the last minute", async () => {
    let now = "2026-10-14T00:00:00.000Z";
    const { service, kicks, store } = buildMeetings({ roster: roster() });
    const m = await service.create("usr_admin", BASE);
    kicks.length = 0;
    store.meetings.set(m.id, { ...store.meetings.get(m.id)!, syncedAt: now });
    const svc = buildMeetings({ roster: roster(), store, now: () => now });
    await svc.service.list();
    expect(svc.kicks).toEqual([]);
    now = "2026-10-14T00:05:00.000Z";
    await svc.service.list();
    expect(svc.kicks).toEqual([15_000]);
  });

  it("a meeting moved to another target while the sync ran is not removed", async () => {
    const { service, calendar, store } = buildMeetings({ roster: roster() });
    const m = await service.create("usr_admin", BASE);
    const stale = { ...store.meetings.get(m.id)! };
    await service.update(m.id, { targetId: "role_pr" }); // new event, old one deleted
    expect(await calendar.getEvent(stale.calendarId, stale.googleEventId)).toBeNull();
    expect(await store.deleteMeetingIf(stale.id, stale.calendarId, stale.googleEventId)).toBe(false);
    expect(store.meetings.has(m.id)).toBe(true);
  });

  it("the sync never overwrites an edit that landed after it read the row", async () => {
    const { service, store } = buildMeetings({ roster: roster() });
    const m = await service.create("usr_admin", BASE);
    const stale = { ...store.meetings.get(m.id)! };
    await service.update(m.id, { title: "新しい名前" });
    expect(await store.updateMeetingIf({ ...stale, syncedAt: "x" }, stale.updatedAt)).toBe(false);
    expect(store.meetings.get(m.id)!.title).toBe("新しい名前");
  });

  it("an HTML description written by Google's editor is not pulled in", async () => {
    const { service, calendar, store } = buildMeetings({ roster: roster() });
    const m = await service.create("usr_admin", { ...BASE, description: "議題" });
    eventOf(calendar).description = "議題<br><b>追記</b>";
    await service.sync();
    expect(store.meetings.get(m.id)!.description).toBe("議題");
  });

  it("a cut-off create whose event id is already taken (deleted in Google) is removed, not retried forever", async () => {
    const base = createMockCalendarClient();
    const calendar = { ...base, getEvent: async (c: string, e: string) => (base.state.calendars.get(c)?.events.has(e) ? base.getEvent(c, e) : null) };
    const { service, store } = buildMeetings({ roster: roster(), calendar });
    const m = await service.create("usr_admin", BASE);
    const row = store.meetings.get(m.id)!;
    await calendar.deleteEvent(row.calendarId, row.googleEventId);
    store.meetings.set(m.id, { ...row, syncedAt: null });
    await service.sync();
    expect(store.meetings.has(m.id)).toBe(false);
  });

  it("the real client: insert with an id is idempotent (409 returns the existing event)", async () => {
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const u = new URL(String(input));
      if (init?.method === "POST") return new Response(JSON.stringify({ error: { code: 409, message: "duplicate" } }), { status: 409 });
      if (u.pathname.endsWith("/events/dubabc")) return Response.json({ id: "dubabc", hangoutLink: "https://meet.google.com/x", summary: "S", start: { dateTime: "2026-10-20T19:00:00+09:00" }, end: { dateTime: "2026-10-20T20:00:00+09:00" } });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const token = { getAccessToken: async () => "tok", grantedScopes: async () => null };
    const client = createGoogleCalendarClient({ token, fetchImpl });
    const ev = await client.insertEvent("cal", { id: "dubabc", summary: "S", description: null, start: "", end: "", timeZone: "Asia/Tokyo", recurrence: [], attendees: [] });
    expect(ev).toMatchObject({ id: "dubabc", meetUrl: "https://meet.google.com/x", start: "2026-10-20T10:00:00.000Z", end: "2026-10-20T11:00:00.000Z" });
  });
});

describe("calendar scope gate", () => {
  function appWith(calendarReady: boolean) {
    const client = createMockDriveShareClient();
    const { service: roleGrants } = buildRoleGrants({ drive: client, roster: fakeRoster({}) });
    const meetings = buildMeetings({ roster: roster(), calendarReady });
    return createApp({
      service: createDriveShareService({ client, config: { listPageSize: 50 } }),
      roleGrants,
      authz: memAuthzHolding("app:calendar:view", "app:calendar:edit", "calendar:meetings_view", "calendar:meetings_edit"),
      googleAccount: stubGoogleAccount(),
      meetings: async () => meetings.service,
    });
  }
  const JSON_HDR = { ...AUTHED, "content-type": "application/json" };

  it("calendarReady=false: writes 409 with the reconnect message, reads still answer", async () => {
    const app = appWith(false);
    const res = await app.request("/meetings", { method: "POST", headers: JSON_HDR, body: JSON.stringify(BASE) });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error.message).toBe(
      "Google アカウントにカレンダーの権限がありません。Drive共有 > 設定 で同じアカウントを「再接続」してください。",
    );
    expect((await app.request("/meetings/sync", { method: "POST", headers: AUTHED })).status).toBe(409);
    const list = await app.request("/meetings", { headers: AUTHED });
    expect(list.status).toBe(200);
    expect(((await list.json()) as any).account).toEqual({ email: "hackit@gmail.com", calendarReady: false });
  });

  it("calendarReady=true: create 201, list, targets (isMine), sync, delete 204", async () => {
    const app = appWith(true);
    const created = await app.request("/meetings", { method: "POST", headers: JSON_HDR, body: JSON.stringify(BASE) });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as any;
    const list = (await (await app.request("/meetings", { headers: AUTHED })).json()) as any;
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id, targetName: "開発", attendeeCount: 2 });

    const targets = (await (await app.request("/meetings/targets", { headers: { "x-dub-user-id": "usr_c" } })).json()) as any;
    expect(targets.items).toEqual([
      { id: "all", name: "全体", memberCount: 3, isMine: true },
      { id: "role_dev", name: "開発", memberCount: 2, isMine: false },
      { id: "role_pr", name: "広報", memberCount: 2, isMine: true },
    ]);

    const sync = await app.request("/meetings/sync", { method: "POST", headers: AUTHED });
    expect(sync.status).toBe(200);
    expect((await sync.json()) as any).not.toHaveProperty("complete");

    const patched = await app.request(`/meetings/${id}`, { method: "PATCH", headers: JSON_HDR, body: JSON.stringify({ title: "改名" }) });
    expect(((await patched.json()) as any).title).toBe("改名");
    expect((await app.request(`/meetings/${id}`, { method: "DELETE", headers: AUTHED })).status).toBe(204);
  });

  it("detects the scope from the token response", async () => {
    const tokenFetch = (scope: string | undefined) =>
      (async () => Response.json({ access_token: "at", expires_in: 3600, ...(scope !== undefined ? { scope } : {}) })) as unknown as typeof fetch;
    const creds = { source: "secret" as const, credentials: { clientId: "c", clientSecret: "s", refreshToken: "r" } };
    const env = {} as Env;
    expect((await resolveMeetingAccount(env, creds, tokenFetch("https://www.googleapis.com/auth/drive"))).calendarReady).toBe(false);
    expect(
      (await resolveMeetingAccount(env, creds, tokenFetch("https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/calendar"))).calendarReady,
    ).toBe(true);
    expect((await resolveMeetingAccount(env, creds, tokenFetch(undefined))).calendarReady).toBe(true);
    const mock = await resolveMeetingAccount(env, { source: "none" });
    expect(mock).toMatchObject({ accountId: "mock", calendarReady: true });
    // the token provider surfaces the scope itself
    const tp = createTokenProvider({ credentials: creds.credentials, fetchImpl: tokenFetch("a b") });
    expect(await tp.grantedScopes()).toEqual(["a", "b"]);
  });
});

describe("MeetingSyncDO alarm scheduling", () => {
  const now = 1_000_000;
  it("schedules when no alarm is pending or the pending one is overdue (never stuck)", () => {
    expect(nextAlarmAt(null, now)).toBe(now + 3_600_000);
    expect(nextAlarmAt(now - 1, now)).toBe(now + 3_600_000);
    expect(nextAlarmAt(now, now, 60_000)).toBe(now + 60_000);
  });
  it("keeps a future alarm, but pulls it earlier for a kick", () => {
    expect(nextAlarmAt(now + 10_000, now)).toBeNull();
    expect(nextAlarmAt(now + 3_600_000, now, 60_000)).toBe(now + 60_000);
    expect(nextAlarmAt(now + 30_000, now, 60_000)).toBeNull();
  });
});
