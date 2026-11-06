// The hourly alarm loop: meeting sync -> Meet ingest -> Drive共有 role follow, each in its own
// invocation. A phase that fails must not stop the others or strand the loop.
import { describe, it, expect, vi, beforeEach } from "vitest";
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

  it("skips quietly when there is no usable Google account", async () => {
    wiring.roleShares.mockResolvedValue(null);
    const { dob, fake } = build();
    await dob.alarm();
    await dob.alarm();
    await dob.alarm();
    expect(fake.kv.get("phase")).toBe("sync");
  });
});
