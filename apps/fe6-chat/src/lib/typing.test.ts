import { afterEach, describe, expect, it, vi } from "vitest";
import type { common } from "@dub/types";
import { getTypingUsers, getTypingVersion, resetTyping, setTyping, clearTyping, subscribeTyping } from "./typing";

const CH = "chn_1" as common.ChannelId;
const U1 = "usr_1" as common.UserId;
const U2 = "usr_2" as common.UserId;

afterEach(() => {
  resetTyping();
  vi.useRealTimers();
});

describe("typing store", () => {
  it("adds a typing user and notifies subscribers", () => {
    const cb = vi.fn();
    subscribeTyping(CH, cb);
    setTyping(CH, U1, 1000);
    expect(getTypingUsers(CH)).toEqual([U1]);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("keeps a stable snapshot reference when the set is unchanged", () => {
    setTyping(CH, U1, 1000);
    const first = getTypingUsers(CH);
    setTyping(CH, U1, 1000); // refresh TTL only — no membership change
    expect(getTypingUsers(CH)).toBe(first);
  });

  it("bumps the version when the set changes", () => {
    const v0 = getTypingVersion(CH);
    setTyping(CH, U1, 1000);
    setTyping(CH, U2, 1000);
    expect(getTypingVersion(CH)).toBe(v0 + 2);
    expect(getTypingUsers(CH)).toEqual([U1, U2]);
  });

  it("auto-clears a user after the TTL lapses", () => {
    vi.useFakeTimers();
    setTyping(CH, U1, 1000);
    expect(getTypingUsers(CH)).toEqual([U1]);
    vi.advanceTimersByTime(1001);
    expect(getTypingUsers(CH)).toEqual([]);
  });

  it("clearTyping removes a single user", () => {
    setTyping(CH, U1, 5000);
    setTyping(CH, U2, 5000);
    clearTyping(CH, U1);
    expect(getTypingUsers(CH)).toEqual([U2]);
  });
});
