// A Google Calendar usage limit: the run stops at once, the sync pauses (MeetingSyncDO storage) —
// only the shares when it was a share — other APIs keep running, and the user is told it was the
// calendar, not Drive.
import { describe, it, expect, vi, afterEach } from "vitest";
import { DubError } from "@dub/errors";
import { GoogleQuotaError, isCalendarQuota, mapGoogleError } from "../src/drive-client";
import { createMockCalendarClient } from "../src/calendar-mock-client";
import { createGoogleCalendarClient, type CalendarClient } from "../src/google/calendar-client";
import { createInMemorySyncState } from "../src/meeting-sync-state";
import { QUOTA_PAUSE_MS } from "../src/meetings-service";
import type { ActiveUser } from "../src/role-membership";
import { buildMeetings, fakeRoster } from "./helpers";

const body = (reason: string, message = "Calendar usage limits exceeded.") => ({ error: { code: 403, message, errors: [{ reason, domain: "calendar" }] } });
const quota = () => new GoogleQuotaError("calendar", "quotaExceeded", "Calendar usage limits exceeded.", "acl.insert");

const USERS: ActiveUser[] = ["a", "b", "c", "d"].map((x) => ({ id: `usr_${x}`, email: `${x}@dub.example`, name: x, roleIds: ["role_dev"] }));
const roster = () => fakeRoster({}, { role_dev: "開発", role_pr: "広報" }, USERS);
const BASE = { title: "開発定例", targetId: "role_dev", startsAt: "2026-10-20T10:00:00.000Z", durationMinutes: 60, recurrence: "weekly" };
const CAL_MESSAGE = "Google カレンダーの利用上限に達しました。時間を置いて再試行してください";

/** Records every client call; `fail(method, nth)` throws from that call on. */
function spied(inner: CalendarClient = createMockCalendarClient()) {
  const calls: string[] = [];
  const failing = new Map<string, () => Error | null>();
  const client = Object.fromEntries(
    (Object.keys(inner) as (keyof CalendarClient)[]).filter((k) => typeof inner[k] === "function").map((k) => [
      k,
      async (...args: unknown[]) => {
        calls.push(k);
        const err = failing.get(k)?.();
        if (err) throw err;
        return (inner[k] as (...a: unknown[]) => unknown)(...args);
      },
    ]),
  ) as unknown as CalendarClient;
  return {
    client,
    calls,
    count: (k: string) => calls.filter((c) => c === k).length,
    fail: (k: keyof CalendarClient, err: () => Error | null) => failing.set(k, err),
    heal: () => failing.clear(),
  };
}

function setup(now = { iso: "2026-10-14T00:00:00.000Z" }) {
  const spy = spied();
  const syncState = createInMemorySyncState();
  const built = buildMeetings({ roster: roster(), calendar: spy.client, syncState, now: () => now.iso });
  return { ...built, spy, syncState, now };
}

afterEach(() => vi.restoreAllMocks());

describe("mapGoogleError — usage limits", () => {
  it.each(["quotaExceeded", "rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded"])("%s on Calendar is a calendar quota error", (reason) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const err = mapGoogleError(403, body(reason), { api: "calendar", operation: "acl.insert" });
    expect(isCalendarQuota(err)).toBe(true);
    expect(err.message).toBe(CAL_MESSAGE);
    expect(err.retryable).toBe(false);
  });

  it("a 429 is a limit whatever its reason", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(isCalendarQuota(mapGoogleError(429, null, { api: "calendar" }))).toBe(true);
  });

  it("the same reason on Drive reads as Drive, and is not a calendar quota", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const err = mapGoogleError(403, body("quotaExceeded"));
    expect(err).toBeInstanceOf(GoogleQuotaError);
    expect(isCalendarQuota(err)).toBe(false);
    expect(err.message).toContain("Google ドライブの利用上限");
    expect(err.message).not.toContain("カレンダー");
  });

  it("uses a code the SPA does not replace with fixed copy", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const err = mapGoogleError(403, body("quotaExceeded"), { api: "calendar" }) as DubError;
    expect(["FORBIDDEN", "RATE_LIMITED"]).not.toContain(err.code);
    expect(err.status).toBe(429);
  });

  it("disk space and a plain refusal are not usage limits", () => {
    expect(mapGoogleError(403, body("storageQuotaExceeded"))).not.toBeInstanceOf(GoogleQuotaError);
    const refused = mapGoogleError(403, body("forbiddenForNonOrganizer"), { api: "calendar" });
    expect(refused).not.toBeInstanceOf(GoogleQuotaError);
    expect(refused.message).toContain("Google カレンダーで操作が拒否されました");
    expect(refused.message).not.toContain("Drive");
  });

  it("logs reason, Google's message and the API name, without addresses", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mapGoogleError(403, body("quotaExceeded", "limit for a@dub.example reached"), { api: "calendar", operation: "acl.insert" });
    const line = JSON.parse(warn.mock.calls[0]![0] as string);
    expect(line).toMatchObject({ event: "google_quota_exceeded", api: "calendar", operation: "acl.insert", reason: "quotaExceeded" });
    expect(line.googleMessage).toContain("limit for");
    expect(JSON.stringify(line)).not.toContain("a@dub.example");
  });
});

describe("real Calendar client", () => {
  const token = { getAccessToken: async () => "t", grantedScopes: async () => null };
  const answer = (status: number, json: unknown) => new Response(JSON.stringify(json), { status });

  it("names the Calendar method on a limit", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const c = createGoogleCalendarClient({ token, fetchImpl: (async () => answer(403, body("quotaExceeded"))) as typeof fetch });
    await expect(c.insertAcl("cal", "a@b.c")).rejects.toMatchObject({ api: "calendar", operation: "acl.insert" });
  });

  it("shares a calendar without Google's share mail (sendNotifications=false)", async () => {
    const calls: { url: URL; method: string; body: unknown }[] = [];
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      calls.push({ url: new URL(String(input)), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      return answer(200, { id: "user:a@b.c" });
    }) as unknown as typeof fetch;
    const c = createGoogleCalendarClient({ token, fetchImpl });
    await expect(c.insertAcl("cal_dev@group.calendar.google.com", "a@b.c")).resolves.toEqual({ id: "user:a@b.c" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe("/calendar/v3/calendars/cal_dev%40group.calendar.google.com/acl");
    expect(calls[0]!.url.searchParams.get("sendNotifications")).toBe("false");
    expect(calls[0]!.body).toEqual({ role: "reader", scope: { type: "user", value: "a@b.c" } });
  });

  it("a limit on Meet REST is a Meet limit, even through the calendar client", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const c = createGoogleCalendarClient({ token, fetchImpl: (async () => answer(429, { error: { message: "x", status: "RESOURCE_EXHAUSTED" } })) as typeof fetch });
    const err = await c.openMeet("https://meet.google.com/abc-defg-hij").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleQuotaError);
    expect(isCalendarQuota(err)).toBe(false);
  });
});

describe("sync on a calendar limit", () => {
  it("a refused share pauses the shares only, and the run still counts as finished", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { service, spy, syncState } = setup();
    await service.create("usr_admin", BASE);
    spy.calls.length = 0;
    spy.fail("insertAcl", quota);

    const r = await service.sync({ system: true });

    expect(spy.count("insertAcl")).toBe(1); // four members, one call
    expect(r.complete).toBe(true);
    expect(r.quotaPausedUntil).toBeUndefined();
    expect(r.aclContinueMs).toBe(QUOTA_PAUSE_MS);
    const state = await syncState.load();
    expect(state.pausedUntil).toBeNull();
    expect(state.aclWritesNotBefore).toBe(Date.parse("2026-10-14T00:00:00.000Z") + QUOTA_PAUSE_MS);
    const events = warn.mock.calls.map((c) => JSON.parse(c[0] as string));
    const paused = events.filter((e) => e.event === "meeting_shares_quota_paused");
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatchObject({ reason: "quotaExceeded", operation: "acl.insert", pausedUntil: "2026-10-14T06:00:00.000Z" });
    expect(events.some((e) => e.event === "meeting_sync_quota_paused")).toBe(false);
    expect(events.some((e) => e.event === "meeting_calendar_acl_failed")).toBe(false);
  });

  it("a member who joins the role while shares are paused is still invited on the next run", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const users: ActiveUser[] = USERS.map((u) => ({ ...u, roleIds: [...u.roleIds] }));
    users.push({ id: "usr_e", email: "e@dub.example", name: "e", roleIds: [] });
    const spy = spied();
    const now = { iso: "2026-10-14T00:00:00.000Z" };
    const { service, store } = buildMeetings({ roster: fakeRoster({}, { role_dev: "開発" }, users), calendar: spy.client, syncState: createInMemorySyncState(), now: () => now.iso });
    const m = await service.create("usr_admin", BASE);
    spy.fail("insertAcl", quota);
    await service.sync({ system: true }); // shares hit the limit
    spy.calls.length = 0;

    users[4]!.roleIds.push("role_dev"); // the role is granted afterwards
    now.iso = "2026-10-14T01:00:00.000Z";
    const r = await service.sync({ system: true });

    expect(r.invitedAdded).toBe(1);
    expect((await store.listInvites(m.id)).map((i) => i.email)).toContain("e@dub.example");
    expect(spy.count("patchEvent")).toBe(1);
    expect(spy.count("insertAcl")).toBe(0); // shares wait out their pause
  });

  it("shares resume once their pause is over", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { service, spy, now, store } = setup();
    await service.create("usr_admin", BASE);
    spy.fail("insertAcl", quota);
    await service.sync({ system: true });
    spy.heal();

    now.iso = "2026-10-14T05:59:59.000Z";
    const waiting = await service.sync({ system: true });
    expect(store.acl).toHaveLength(0);
    expect(waiting.aclContinueMs).toBe(1000);

    now.iso = "2026-10-14T06:00:00.000Z";
    await service.sync({ system: true });
    expect(store.acl).toHaveLength(4);
  });

  it("a manual sync whose shares hit the limit still answers", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { service, spy, syncState } = setup();
    await service.create("usr_admin", BASE);
    spy.fail("insertAcl", quota);

    await expect(service.sync()).resolves.toMatchObject({ complete: true });
    expect((await syncState.load()).pausedUntil).toBeNull();
  });

  it("a limit on the event calls pauses the whole sync", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { service, spy } = setup();
    await service.create("usr_admin", BASE);
    spy.calls.length = 0;
    spy.fail("getEvent", quota);

    const r = await service.sync({ system: true });

    expect(r.complete).toBe(true);
    expect(r.quotaPausedUntil).toBe(Date.parse("2026-10-14T00:00:00.000Z") + QUOTA_PAUSE_MS);
    expect(spy.count("insertAcl")).toBe(0);
    expect(spy.count("openMeet")).toBe(0);
    const paused = warn.mock.calls.map((c) => JSON.parse(c[0] as string)).filter((e) => e.event === "meeting_sync_quota_paused");
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatchObject({ pausedUntil: "2026-10-14T06:00:00.000Z" });
  });

  it("makes no Calendar call while paused, opens Meets, and resumes after the deadline", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { service, spy, now, store } = setup();
    await service.create("usr_admin", BASE);
    spy.fail("getEvent", quota);
    await service.sync({ system: true });
    spy.heal();
    spy.calls.length = 0;

    now.iso = "2026-10-14T05:59:59.000Z";
    const paused = await service.sync({ system: true });
    expect(spy.calls.filter((c) => c !== "openMeet")).toEqual([]);
    expect(paused.complete).toBe(true);
    await expect(service.sync()).rejects.toMatchObject({ code: "GOOGLE_QUOTA_EXCEEDED", message: CAL_MESSAGE });
    expect(spy.calls.filter((c) => c !== "openMeet")).toEqual([]);

    now.iso = "2026-10-14T06:00:00.000Z";
    const resumed = await service.sync({ system: true });
    expect(resumed.quotaPausedUntil).toBeUndefined();
    expect(store.acl).toHaveLength(4);
  });

  it("a limit on resuming pauses again, six hours from then", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { service, spy, now } = setup();
    await service.create("usr_admin", BASE);
    spy.fail("getEvent", quota);
    await service.sync({ system: true });

    now.iso = "2026-10-14T06:00:00.000Z";
    const r = await service.sync({ system: true });

    expect(r.quotaPausedUntil).toBe(Date.parse("2026-10-14T12:00:00.000Z"));
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("meeting_sync_quota_paused"))).toHaveLength(2);
  });

  it("a manual sync that hits the limit on an event shows it and pauses the alarm too", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { service, spy, syncState, kicks } = setup();
    await service.create("usr_admin", BASE);
    spy.fail("getEvent", quota);
    kicks.length = 0;

    await expect(service.sync()).rejects.toThrow(CAL_MESSAGE);

    expect((await syncState.load()).pausedUntil).not.toBeNull();
    expect(kicks).toEqual([]);
  });

  it("a limit on Meet REST pauses nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { service, spy, syncState } = setup();
    await service.create("usr_admin", BASE);
    spy.fail("openMeet", () => new GoogleQuotaError("meet", "http_429"));
    await service.sync({ system: true });
    expect((await syncState.load()).pausedUntil).toBeNull();
  });
});

describe("writes on a calendar limit", () => {
  it("a create that hits it leaves nothing, makes no clean-up call, and pauses the sync once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { service, spy, store, syncState } = setup();
    spy.fail("insertEvent", quota);

    await expect(service.create("usr_admin", BASE)).rejects.toThrow(CAL_MESSAGE);
    await expect(service.create("usr_admin", BASE)).rejects.toThrow(CAL_MESSAGE);

    expect(store.meetings.size).toBe(0);
    expect(spy.count("deleteEvent")).toBe(0);
    expect((await syncState.load()).pausedUntil).not.toBeNull();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("meeting_sync_quota_paused"))).toHaveLength(1);
  });

  it("a target change refused before the new event leaves D1 and the old event alone", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { service, spy, store } = setup();
    const m = await service.create("usr_admin", BASE);
    const before = { row: { ...store.meetings.get(m.id)! }, invites: await store.listInvites(m.id) };
    spy.calls.length = 0;
    spy.fail("insertEvent", quota);

    await expect(service.update(m.id, { targetId: "role_pr" }, "usr_admin")).rejects.toThrow(CAL_MESSAGE);

    expect(store.meetings.get(m.id)).toEqual(before.row);
    expect(await store.listInvites(m.id)).toEqual(before.invites);
    expect(spy.count("deleteEvent")).toBe(0);
    expect(spy.count("patchEvent")).toBe(0);
  });

  it("writes still reach Google during a pause (only the sync stands down)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { service, spy, syncState } = setup();
    await syncState.pause(0, Date.parse("2026-10-15T00:00:00.000Z"));
    await service.create("usr_admin", BASE);
    expect(spy.count("insertEvent")).toBe(1);
  });
});
