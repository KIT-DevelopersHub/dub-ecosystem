// Fewer Calendar calls: failed shares wait, unchanged calendars skip listAcl, ended meetings leave
// the sync, and share writes are paced.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockCalendarClient } from "../src/calendar-mock-client";
import type { CalendarClient } from "../src/google/calendar-client";
import { createInMemorySyncState } from "../src/meeting-sync-state";
import { ACL_FULL_CHECK_MS, ACL_RETRY_WAIT_MS, ACL_WRITE_INTERVAL_MS, ACL_WRITES_PER_RUN, ENDED_SYNC_GRACE_MS } from "../src/meetings-service";
import { lastEndMs } from "../src/meeting-rules";
import type { ActiveUser } from "../src/role-membership";
import type { MemberDirectory } from "../src/member-directory";
import { buildMeetings, fakeRoster } from "./helpers";

const member = (x: string): ActiveUser => ({ id: `usr_${x}`, email: `${x}@dub.example`, name: x, roleIds: ["role_dev"] });
const BASE = { title: "定例", targetId: "role_dev", startsAt: "2026-10-20T10:00:00.000Z", durationMinutes: 60, recurrence: "weekly" };
const T0 = Date.parse("2026-10-14T00:00:00.000Z");

function setup(users: ActiveUser[] = ["a", "b"].map(member), extra: { googleBudget?: number; directory?: MemberDirectory } = {}) {
  const inner = createMockCalendarClient();
  const calls: string[] = [];
  const failing = new Map<string, (arg: unknown) => Error | null>();
  const calendar = Object.fromEntries(
    (Object.keys(inner) as (keyof CalendarClient)[]).filter((k) => typeof inner[k] === "function").map((k) => [
      k,
      async (...args: unknown[]) => {
        calls.push(k);
        const err = failing.get(k)?.(args[1]);
        if (err) throw err;
        return (inner[k] as (...a: unknown[]) => unknown)(...args);
      },
    ]),
  ) as unknown as CalendarClient;
  const clock = { ms: T0 };
  const people = { users };
  const roster = { ...fakeRoster({}, { role_dev: "開発" }, users), listActiveUsers: async () => people.users };
  const syncState = createInMemorySyncState();
  const built = buildMeetings({ roster, calendar, syncState, now: () => new Date(clock.ms).toISOString(), ...extra });
  const count = (k: string) => calls.filter((c) => c === k).length;
  /** Calls of one sync at `at`. */
  const syncAt = async (at: number, opts: { aclOnly?: boolean } = {}) => {
    clock.ms = at;
    calls.length = 0;
    return built.service.sync({ system: true, ...opts });
  };
  return { ...built, inner, calls, failing, clock, people, count, syncAt, syncState };
}

beforeEach(() => void vi.spyOn(console, "warn").mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

describe("a failed share waits", () => {
  it("is not retried inside the wait, and is once it is over", async () => {
    const { service, failing, count, syncAt, store } = setup();
    await service.create("usr_admin", BASE);
    failing.set("insertAcl", (email) => (email === "a@dub.example" ? new Error("cannot share") : null));

    await syncAt(T0);
    expect(count("insertAcl")).toBe(2);

    await syncAt(T0 + ACL_RETRY_WAIT_MS - 1000);
    expect(count("insertAcl")).toBe(0);

    failing.clear();
    await syncAt(T0 + ACL_RETRY_WAIT_MS);
    expect(count("insertAcl")).toBe(1);
    expect(store.acl.map((r) => r.email).sort()).toEqual(["a@dub.example", "b@dub.example"]);
  });

  it("keeps waiting when someone else's change opens the calendar", async () => {
    const { service, failing, count, syncAt, people, store } = setup();
    await service.create("usr_admin", BASE);
    failing.set("insertAcl", (email) => (email === "a@dub.example" ? new Error("cannot share") : null));
    await syncAt(T0);

    people.users = ["a", "b", "c"].map(member);
    await syncAt(T0 + 60_000);

    expect(count("insertAcl")).toBe(1);
    expect(store.acl.map((r) => r.email)).toContain("c@dub.example");
  });

  it("a member who left and came back is tried at once", async () => {
    const { service, failing, count, syncAt, people } = setup();
    await service.create("usr_admin", BASE);
    failing.set("insertAcl", (email) => (email === "a@dub.example" ? new Error("cannot share") : null));
    await syncAt(T0);

    people.users = [member("b")];
    await syncAt(T0 + 60_000);
    people.users = ["a", "b"].map(member);
    failing.clear();
    await syncAt(T0 + 120_000);

    expect(count("insertAcl")).toBe(1);
  });

  it("a limit is not recorded as a failed share", async () => {
    const { service, failing, syncAt, syncState } = setup();
    await service.create("usr_admin", BASE);
    const { GoogleQuotaError } = await import("../src/drive-client");
    failing.set("insertAcl", () => new GoogleQuotaError("calendar", "quotaExceeded"));
    await syncAt(T0);
    const acl = Object.values((await syncState.load()).acl);
    expect(acl.flatMap((a) => Object.keys(a.retryAt))).toEqual([]);
  });
});

describe("an unchanged calendar skips listAcl", () => {
  it("calls it when the list changed and once a day, not otherwise", async () => {
    const { service, count, syncAt, people } = setup();
    await service.create("usr_admin", BASE);

    await syncAt(T0);
    expect(count("listAcl")).toBe(1);

    await syncAt(T0 + 60 * 60_000);
    expect(count("listAcl")).toBe(0);
    expect(count("insertAcl")).toBe(0);

    people.users = ["a", "b", "c"].map(member);
    await syncAt(T0 + 2 * 60 * 60_000);
    expect(count("listAcl")).toBe(1);
    expect(count("insertAcl")).toBe(1);

    await syncAt(T0 + 2 * 60 * 60_000 + ACL_FULL_CHECK_MS - 1000);
    expect(count("listAcl")).toBe(0);

    await syncAt(T0 + 2 * 60 * 60_000 + ACL_FULL_CHECK_MS);
    expect(count("listAcl")).toBe(1);
  });

  it("the daily check puts back a share removed in Google, and leaves one added by hand", async () => {
    const { service, syncAt, count, store, inner } = setup();
    const m = await service.create("usr_admin", BASE);
    await syncAt(T0);
    const c = inner.state.calendars.get(store.meetings.get(m.id)!.calendarId)!;
    c.acl = c.acl.filter((r) => r.email !== "a@dub.example");
    c.acl.push({ id: "user:hand@dub.example", role: "reader", email: "hand@dub.example" });

    await syncAt(T0 + 60 * 60_000);
    expect(count("insertAcl")).toBe(0);

    await syncAt(T0 + ACL_FULL_CHECK_MS);
    expect(count("insertAcl")).toBe(1);
    expect(count("deleteAcl")).toBe(0);
    expect(c.acl.some((r) => r.email === "hand@dub.example")).toBe(true);
  });
});

describe("ended meetings", () => {
  const ONE_OFF = { ...BASE, recurrence: "none", startsAt: "2026-10-14T01:00:00.000Z" }; // ends 02:00
  const END = Date.parse("2026-10-14T02:00:00.000Z");

  it("leave the sync after the grace: no getEvent, no invite update", async () => {
    const { service, count, syncAt, people } = setup();
    await service.create("usr_admin", ONE_OFF);
    people.users = ["a", "b", "c"].map(member);

    const r = await syncAt(END + ENDED_SYNC_GRACE_MS);

    expect(r.meetings).toBe(0);
    expect(count("getEvent")).toBe(0);
    expect(count("patchEvent")).toBe(0);
  });

  it("are frozen from the moment they end: edits still arrive, no invite mail goes out", async () => {
    const { service, count, syncAt, people } = setup();
    await service.create("usr_admin", ONE_OFF);
    people.users = ["a", "b", "c"].map(member);

    await syncAt(END + 60_000);

    expect(count("getEvent")).toBe(1);
    expect(count("patchEvent")).toBe(0);
  });

  it("a create cut off before its event is not finished once the meeting has passed", async () => {
    const { service, store, count, syncAt, inner } = setup();
    const m = await service.create("usr_admin", ONE_OFF);
    const row = store.meetings.get(m.id)!;
    store.meetings.set(m.id, { ...row, syncedAt: null });
    inner.state.deleted.add(`${row.calendarId} ${row.googleEventId}`);

    await syncAt(END + 60_000);

    expect(count("getEvent")).toBe(1);
    expect(count("insertEvent")).toBe(0);
    expect(store.meetings.has(m.id)).toBe(true);
  });

  it("a meeting moved forward in Google is live again, invites included", async () => {
    const { service, count, syncAt, people, store, inner } = setup();
    const m = await service.create("usr_admin", ONE_OFF);
    const row = store.meetings.get(m.id)!;
    const ev = inner.state.calendars.get(row.calendarId)!.events.get(row.googleEventId)!;
    ev.start = "2026-10-30T01:00:00.000Z";
    ev.end = "2026-10-30T02:00:00.000Z";
    people.users = ["a", "b", "c"].map(member);

    await syncAt(END + 60_000);

    expect(count("patchEvent")).toBe(1);
    expect(store.meetings.get(m.id)!.startsAt).toBe("2026-10-30T01:00:00.000Z");
  });

  it("series: open-ended never ends, one with an end date ends with its last real occurrence", () => {
    const w = { startsAt: BASE.startsAt, durationMinutes: 60, recurrence: "weekly" as const }; // Tuesdays
    expect(lastEndMs({ ...w, until: null })).toBeNull();
    expect(lastEndMs({ ...w, until: "2026-11-30" })).toBe(Date.parse("2026-11-24T11:00:00.000Z"));
    // 3rd Tuesday monthly: the last one is 11/17, not the end of November.
    expect(lastEndMs({ ...w, recurrence: "monthly_weekday", until: "2026-11-30" })).toBe(Date.parse("2026-11-17T11:00:00.000Z"));
    // A series far longer than the occurrence cap still ends at its real end.
    expect(lastEndMs({ ...w, until: "2040-01-10" })).toBe(Date.parse("2040-01-10T11:00:00.000Z"));
  });

  it("a list with only ended meetings does not kick the sync", async () => {
    const { service, kicks, clock } = setup();
    await service.create("usr_admin", ONE_OFF);
    kicks.length = 0;
    clock.ms = END + ENDED_SYNC_GRACE_MS + 60_000;
    await service.list();
    expect(kicks).toEqual([]);
  });
});

describe("share writes are paced", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => member(`m${i}`));

  it("stops at the per-run cap, asks for a continuation, and finishes over later runs", async () => {
    const { service, count, syncAt, store } = setup(many(ACL_WRITES_PER_RUN * 2 + 3));
    await service.create("usr_admin", BASE);

    const first = await syncAt(T0);
    expect(count("insertAcl")).toBe(ACL_WRITES_PER_RUN);
    expect(first.aclContinueMs).toBe(ACL_WRITE_INTERVAL_MS);
    expect(first.complete).toBe(true); // the wait must not hold the other phases

    const second = await syncAt(T0 + ACL_WRITE_INTERVAL_MS, { aclOnly: true });
    expect(count("insertAcl")).toBe(ACL_WRITES_PER_RUN);
    expect(count("getEvent")).toBe(0);
    expect(second.aclContinueMs).toBe(ACL_WRITE_INTERVAL_MS);

    const third = await syncAt(T0 + 2 * ACL_WRITE_INTERVAL_MS, { aclOnly: true });
    expect(count("insertAcl")).toBe(3);
    expect(third.aclContinueMs).toBeUndefined();
    expect(store.acl).toHaveLength(ACL_WRITES_PER_RUN * 2 + 3);
  });

  it("the interval holds whichever run comes next (a manual sync, a kick)", async () => {
    const { service, count, syncAt, calls, clock } = setup(many(ACL_WRITES_PER_RUN + 1));
    await service.create("usr_admin", BASE);
    await syncAt(T0);

    clock.ms = T0 + 60_000;
    calls.length = 0;
    await service.sync();
    expect(count("insertAcl")).toBe(0);
    expect(count("listAcl")).toBe(0);
  });

  it("removals count against the cap too", async () => {
    const { service, count, syncAt, people, store } = setup(many(ACL_WRITES_PER_RUN + 2));
    await service.create("usr_admin", BASE);
    await syncAt(T0);
    await syncAt(T0 + ACL_WRITE_INTERVAL_MS, { aclOnly: true });
    expect(store.acl).toHaveLength(ACL_WRITES_PER_RUN + 2);

    people.users = [member("keep")];
    await syncAt(T0 + 2 * ACL_WRITE_INTERVAL_MS);
    expect(count("insertAcl") + count("deleteAcl")).toBe(ACL_WRITES_PER_RUN);
  });
});

describe("the budget cannot bring the two-minute loop back", () => {
  const FAR = "2026-12-01T01:00:00.000Z";
  const meetings = async (service: { create(u: string, b: unknown): Promise<unknown> }, n: number) => {
    for (let i = 0; i < n; i++) await service.create("usr_admin", { ...BASE, recurrence: "none", startsAt: FAR, title: `m${i}` });
  };

  it("more meetings than the budget: each run goes on from where it stopped, then the scan finishes", async () => {
    const { service, count, syncAt } = setup(undefined, { googleBudget: 35 });
    await meetings(service, 40);

    const first = await syncAt(T0);
    expect(first.complete).toBe(false);
    expect(count("getEvent")).toBe(35);

    const second = await syncAt(T0 + 120_000);
    expect(second.complete).toBe(true);
    expect(count("getEvent")).toBe(5);
    expect(count("listAcl")).toBe(1); // shares are reached

    await syncAt(T0 + 3_600_000);
    expect(count("getEvent")).toBe(35); // the next hour starts over
  });

  it("running out during the shares paces them instead of re-running the scan", async () => {
    const { service, count, syncAt } = setup(["a", "b", "c", "d", "e", "f", "g", "h", "i"].map(member), { googleBudget: 8 });
    await meetings(service, 4);

    const r = await syncAt(T0);

    expect(count("insertAcl")).toBe(3); // 4 getEvent + listAcl + 3 writes
    expect(r.complete).toBe(true);
    expect(r.aclContinueMs).toBe(ACL_WRITE_INTERVAL_MS);
  });

  it("Meets that will not open do not make the run incomplete", async () => {
    const { service, failing, syncAt } = setup(undefined, { googleBudget: 35 });
    await meetings(service, 14);
    failing.set("openMeet", () => new Error("no"));
    const r = await syncAt(T0);
    expect(r.complete).toBe(true);
  });

  it("each meeting is reached even if a stale cursor names one that is gone", async () => {
    const { service, count, syncAt, syncState } = setup();
    await meetings(service, 3);
    await syncState.save({ meetingCursor: "dsm_gone" });
    await syncAt(T0);
    expect(count("getEvent")).toBe(3);
  });
});

describe("a member-service or identity glitch changes nothing", () => {
  it("no 名簿 answer: the sync stops, no invite or share moves", async () => {
    const down: MemberDirectory = { googleEmails: async (_ids, opts) => {
      if (opts?.strict) throw new Error("member-service down");
      return new Map();
    } };
    const { service, count, syncAt } = setup(undefined, { directory: down });
    await service.create("usr_admin", BASE);
    await expect(syncAt(T0)).rejects.toThrow("member-service down");
    expect(count("getEvent")).toBe(0);
    expect(count("patchEvent")).toBe(0);
    expect(count("insertAcl")).toBe(0);
  });

  it("an empty member list unshares nobody", async () => {
    const { service, count, syncAt, people, store } = setup();
    await service.create("usr_admin", BASE);
    await syncAt(T0);
    const shared = store.acl.length;
    people.users = [];
    await syncAt(T0 + 60_000);
    expect(count("deleteAcl")).toBe(0);
    expect(store.acl).toHaveLength(shared);
  });
});
