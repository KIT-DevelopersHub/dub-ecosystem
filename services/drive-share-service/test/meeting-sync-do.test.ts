// The hourly alarm loop: meeting sync -> Meet ingest -> Drive共有 role follow, each in its own
// invocation. A phase that fails must not stop the others or strand the loop.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Env } from "../src/env";

const wiring = vi.hoisted(() => ({
  sync: vi.fn(),
  ingest: vi.fn(),
  roleShares: vi.fn(),
}));
vi.mock("../src/meetings-wiring", () => ({
  buildMeetingsService: async () => ({ sync: wiring.sync }),
  runScheduledMeetIngest: wiring.ingest,
  runScheduledRoleShareSync: wiring.roleShares,
}));

import { MeetingSyncDO } from "../src/meeting-sync-do";

function fakeState() {
  const kv = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    alarm: () => alarm,
    kv,
    state: {
      storage: {
        get: async (k: string) => kv.get(k),
        put: async (k: string, v: unknown) => void kv.set(k, v),
        delete: async (k: string) => kv.delete(k),
        getAlarm: async () => alarm,
        setAlarm: async (at: number) => void (alarm = at),
      },
    },
  };
}

const DONE = { meetings: 0, invitedAdded: 0, invitedRemoved: 0, complete: true };
const ROLE_DONE = { grants: 1, touched: 0, shared: 0, skipped: 0, resume: null };
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

describe("MeetingSyncDO phases", () => {
  beforeEach(() => {
    wiring.sync.mockReset().mockResolvedValue(DONE);
    wiring.ingest.mockReset().mockResolvedValue({ complete: true, occurrences: 0, participants: 0 });
    wiring.roleShares.mockReset().mockResolvedValue(ROLE_DONE);
  });

  function build() {
    const fake = fakeState();
    const dob = new MeetingSyncDO(fake.state as never, {} as Env);
    const untilNext = () => (fake.alarm() as number) - Date.now();
    return { fake, dob, untilNext };
  }

  it("runs sync, ingest and the role follow in turn, then waits an hour", async () => {
    const { dob, untilNext, fake } = build();

    await dob.alarm();
    expect(wiring.sync).toHaveBeenCalledTimes(1);
    expect(untilNext()).toBeLessThanOrEqual(MIN);

    await dob.alarm();
    expect(wiring.ingest).toHaveBeenCalledTimes(1);
    expect(wiring.roleShares).not.toHaveBeenCalled();
    expect(untilNext()).toBeLessThanOrEqual(MIN);

    await dob.alarm();
    expect(wiring.roleShares).toHaveBeenCalledTimes(1);
    expect(untilNext()).toBeGreaterThan(50 * MIN);
    expect(untilNext()).toBeLessThanOrEqual(HOUR);
    expect(fake.kv.get("phase")).toBe("sync");
  });

  it("still reaches the role follow when the ingest throws", async () => {
    wiring.ingest.mockRejectedValue(new Error("meet down"));
    const { dob } = build();
    await dob.alarm();
    await dob.alarm();
    await dob.alarm();
    expect(wiring.roleShares).toHaveBeenCalledTimes(1);
  });

  it("an unfinished role follow continues from its resume point, then clears it", async () => {
    const resume = { grantId: "g1", cursor: "b@gmail.com" };
    wiring.roleShares.mockResolvedValueOnce({ ...ROLE_DONE, resume });
    const { dob, fake } = build();
    await dob.alarm();
    await dob.alarm();

    await dob.alarm();
    expect(fake.kv.get("phase")).toBe("roleShares");

    await dob.alarm();
    expect(wiring.roleShares.mock.calls[1]![1]).toMatchObject({ resume });
    expect(fake.kv.has("roleShareResume")).toBe(false);
    expect(fake.kv.get("phase")).toBe("sync");
  });

  it("a failing role follow goes back to the meeting sync with the alarm still set", async () => {
    wiring.roleShares.mockRejectedValue(new Error("drive down"));
    const { dob, fake } = build();
    await dob.alarm();
    await dob.alarm();
    await dob.alarm();
    expect(fake.kv.get("phase")).toBe("sync");
    expect(fake.alarm()).not.toBeNull();

    await dob.alarm();
    expect(wiring.sync).toHaveBeenCalledTimes(2);
  });

  it("a run paused by a calendar limit is not re-run: the ingest and the role follow keep their turn", async () => {
    wiring.sync.mockResolvedValue({ ...DONE, quotaPausedUntil: Date.now() + 6 * HOUR });
    const { dob, fake, untilNext } = build();
    await dob.alarm();
    expect(fake.kv.get("phase")).toBe("ingest");
    expect(untilNext()).toBeLessThanOrEqual(MIN);
    await dob.alarm();
    await dob.alarm();
    expect(wiring.ingest).toHaveBeenCalledTimes(1);
    expect(wiring.roleShares).toHaveBeenCalledTimes(1);
    expect(wiring.sync).toHaveBeenCalledTimes(1);
    expect(untilNext()).toBeGreaterThan(50 * MIN);
  });

  it("a budget stop still continues in two minutes", async () => {
    wiring.sync.mockResolvedValue({ ...DONE, complete: false });
    const { dob, fake, untilNext } = build();
    await dob.alarm();
    expect(fake.kv.get("phase")).toBe("sync");
    expect(untilNext()).toBeLessThanOrEqual(2 * MIN);
  });

  it("holds the pause for the request path; a second pause neither moves nor restarts it", async () => {
    const { dob, fake } = build();
    const post = (path: string, body: unknown) => dob.fetch(new Request(`https://meeting-sync${path}`, { method: "POST", body: JSON.stringify(body) }));
    const now = Date.now();
    const first = await (await post("/sync-state/pause", { now, until: now + 6 * HOUR })).json();
    const again = await (await post("/sync-state/pause", { now: now + HOUR, until: now + 7 * HOUR })).json();
    expect(first).toEqual({ until: now + 6 * HOUR, started: true });
    expect(again).toEqual({ until: now + 6 * HOUR, started: false });
    const state = await (await dob.fetch(new Request("https://meeting-sync/sync-state"))).json();
    expect(state).toMatchObject({ pausedUntil: now + 6 * HOUR });
    expect(fake.alarm()).toBeNull();
  });

  it("a kick during a pause does not pull the alarm (open tabs must not run the phases early)", async () => {
    const { dob, untilNext } = build();
    const now = Date.now();
    await dob.fetch(new Request("https://meeting-sync/sync-state/pause", { method: "POST", body: JSON.stringify({ now, until: now + 6 * HOUR }) }));
    await dob.fetch(new Request("https://meeting-sync/kick", { method: "POST", body: JSON.stringify({ soonMs: 15_000 }) }));
    expect(untilNext()).toBeGreaterThan(50 * MIN);
  });

  describe("paced calendar shares", () => {
    const PACE = 15 * MIN;
    afterEach(() => vi.useRealTimers());

    /** Fire the alarm at its scheduled time. */
    const fire = async (dob: MeetingSyncDO, alarmAt: () => number | null) => {
      vi.setSystemTime(alarmAt() as number);
      await dob.alarm();
    };

    it("do not hold up the cycle: the ingest and the role follow run, then the next batch writes shares only", async () => {
      vi.useFakeTimers();
      wiring.sync.mockResolvedValueOnce({ ...DONE, aclContinueMs: PACE });
      const { dob, fake } = build();
      const start = Date.now();

      await dob.alarm();
      await fire(dob, fake.alarm); // ingest
      await fire(dob, fake.alarm); // role follow
      expect(wiring.ingest).toHaveBeenCalledTimes(1);
      expect(wiring.roleShares).toHaveBeenCalledTimes(1);
      expect(fake.alarm()).toBe(start + PACE);
      expect(fake.kv.get("phase")).toBe("aclShares");

      wiring.sync.mockResolvedValueOnce({ ...DONE, aclContinueMs: PACE });
      await fire(dob, fake.alarm);
      expect(wiring.sync).toHaveBeenLastCalledWith({ system: true, aclOnly: true });
      expect(fake.alarm()).toBe(start + 2 * PACE);
    });

    it("the hourly cycle keeps its time: a batch past it is left to the cycle's sync", async () => {
      vi.useFakeTimers();
      wiring.sync.mockResolvedValueOnce({ ...DONE, aclContinueMs: PACE });
      const { dob, fake } = build();
      await dob.alarm();
      await fire(dob, fake.alarm);
      await fire(dob, fake.alarm);
      const cycleAt = (fake.kv.get("cycleAt") as number);

      wiring.sync.mockResolvedValue({ ...DONE, aclContinueMs: 2 * HOUR });
      await fire(dob, fake.alarm);
      expect(fake.alarm()).toBe(cycleAt);
      expect(fake.kv.get("phase")).toBe("sync");

      wiring.sync.mockResolvedValue(DONE);
      await fire(dob, fake.alarm);
      expect(wiring.sync).toHaveBeenLastCalledWith({ system: true });
    });

    it("a kick that pulls the alarm early runs the normal sync, not a share batch", async () => {
      vi.useFakeTimers();
      wiring.sync.mockResolvedValueOnce({ ...DONE, aclContinueMs: PACE });
      const { dob, fake } = build();
      await dob.alarm();
      await fire(dob, fake.alarm);
      await fire(dob, fake.alarm);
      await dob.fetch(new Request("https://meeting-sync/kick", { method: "POST", body: JSON.stringify({ soonMs: 15_000 }) }));
      await fire(dob, fake.alarm);
      expect(wiring.sync).toHaveBeenLastCalledWith({ system: true });
    });

    it("a batch that throws leaves the loop on its hourly time", async () => {
      vi.useFakeTimers();
      wiring.sync.mockResolvedValueOnce({ ...DONE, aclContinueMs: PACE });
      const { dob, fake } = build();
      await dob.alarm();
      await fire(dob, fake.alarm);
      await fire(dob, fake.alarm);
      wiring.sync.mockRejectedValueOnce(new Error("identity down"));
      await fire(dob, fake.alarm);
      expect(fake.kv.get("phase")).toBe("sync");
      expect(fake.alarm()).toBe(fake.kv.get("cycleAt"));
    });
  });

  it("skips quietly when there is no usable Google account", async () => {
    wiring.roleShares.mockResolvedValue(null);
    const { dob, fake } = build();
    await dob.alarm();
    await dob.alarm();
    await dob.alarm();
    expect(fake.kv.get("phase")).toBe("sync");
  });
});
