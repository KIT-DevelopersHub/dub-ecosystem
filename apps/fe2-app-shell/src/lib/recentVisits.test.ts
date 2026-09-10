// P3-1 recent-visit store: dedup, cap, ordering, persistence, resilience, and the
// nav longest-prefix label/icon resolution.
import { beforeEach, describe, expect, it } from "vitest";
import type { NavEntry } from "../modules/types.tsx";
import {
  MAX_RECENT_VISITS,
  RECENT_VISITS_KEY,
  __resetRecentVisitsCache,
  clearRecentVisits,
  getRecentVisits,
  recordVisit,
  resolveVisitApp,
  subscribeRecentVisits,
} from "./recentVisits.ts";

beforeEach(() => {
  localStorage.clear();
  __resetRecentVisitsCache();
});

const NAV: NavEntry[] = [
  { label: "イベント", path: "/events", icon: "calendar", order: 10 },
  { label: "マイタスク", path: "/me/tasks", icon: "check-square", order: 20 },
  { label: "チャット", path: "/chat", icon: "message-square", order: 30 },
  { label: "運営メンバー・名簿", path: "/members", icon: "users", order: 47 },
];

describe("recentVisits store", () => {
  it("records a visit and returns it, most-recent-first", () => {
    recordVisit({ path: "/events/e1", label: "Conf", app: "イベント", icon: "calendar" });
    recordVisit({ path: "/chat/c1", label: "general", app: "チャット", icon: "message-square" });
    const list = getRecentVisits();
    expect(list.map((v) => v.path)).toEqual(["/chat/c1", "/events/e1"]);
    expect(list[0]!.label).toBe("general");
  });

  it("dedups by path — re-visiting bumps it to the top without duplicating", () => {
    recordVisit({ path: "/events/e1", label: "Conf", app: "イベント", icon: "calendar" });
    recordVisit({ path: "/chat/c1", label: "general", app: "チャット", icon: "message-square" });
    recordVisit({ path: "/events/e1", label: "Conf (renamed)", app: "イベント", icon: "calendar" });
    const list = getRecentVisits();
    expect(list.map((v) => v.path)).toEqual(["/events/e1", "/chat/c1"]);
    expect(list.filter((v) => v.path === "/events/e1")).toHaveLength(1);
    expect(list[0]!.label).toBe("Conf (renamed)"); // label refreshed
  });

  it(`caps the history at MAX_RECENT_VISITS (${MAX_RECENT_VISITS})`, () => {
    for (let i = 0; i < MAX_RECENT_VISITS + 5; i++) {
      recordVisit({ path: `/events/e${i}`, label: `E${i}`, app: "イベント", icon: "calendar" });
    }
    const list = getRecentVisits();
    expect(list).toHaveLength(MAX_RECENT_VISITS);
    // The newest is first, the oldest (e0..e4) were evicted.
    expect(list[0]!.path).toBe(`/events/e${MAX_RECENT_VISITS + 4}`);
    expect(list.some((v) => v.path === "/events/e0")).toBe(false);
  });

  it("persists to localStorage and reloads across a fresh cache", () => {
    recordVisit({ path: "/events/e1", label: "Conf", app: "イベント", icon: "calendar" });
    expect(localStorage.getItem(RECENT_VISITS_KEY)).toContain("/events/e1");
    __resetRecentVisitsCache(); // simulate a page reload
    expect(getRecentVisits().map((v) => v.path)).toEqual(["/events/e1"]);
  });

  it("returns a stable reference between changes (safe for useSyncExternalStore)", () => {
    recordVisit({ path: "/events/e1", label: "Conf", app: "イベント", icon: "calendar" });
    expect(getRecentVisits()).toBe(getRecentVisits());
    recordVisit({ path: "/chat/c1", label: "general", app: "チャット", icon: "message-square" });
    // A change produces a new reference.
    const a = getRecentVisits();
    recordVisit({ path: "/events/e2", label: "E2", app: "イベント", icon: "calendar" });
    expect(getRecentVisits()).not.toBe(a);
  });

  it("notifies subscribers on change and stops after unsubscribe", () => {
    let calls = 0;
    const unsub = subscribeRecentVisits(() => {
      calls += 1;
    });
    recordVisit({ path: "/events/e1", label: "Conf", app: "イベント", icon: "calendar" });
    expect(calls).toBe(1);
    unsub();
    recordVisit({ path: "/chat/c1", label: "general", app: "チャット", icon: "message-square" });
    expect(calls).toBe(1);
  });

  it("clearRecentVisits empties the history", () => {
    recordVisit({ path: "/events/e1", label: "Conf", app: "イベント", icon: "calendar" });
    clearRecentVisits();
    expect(getRecentVisits()).toEqual([]);
  });

  it("degrades to an empty list when the stored value is corrupt", () => {
    localStorage.setItem(RECENT_VISITS_KEY, "{not json");
    __resetRecentVisitsCache();
    expect(getRecentVisits()).toEqual([]);
  });

  it("drops malformed entries but keeps valid ones", () => {
    localStorage.setItem(
      RECENT_VISITS_KEY,
      JSON.stringify([
        { path: "/events/e1", label: "Conf", app: "イベント", icon: "calendar", at: 1 },
        { path: 123, label: "bad" }, // malformed
      ]),
    );
    __resetRecentVisitsCache();
    const list = getRecentVisits();
    expect(list).toHaveLength(1);
    expect(list[0]!.path).toBe("/events/e1");
  });
});

describe("resolveVisitApp", () => {
  it("matches a detail route to its owning app (longest prefix)", () => {
    expect(resolveVisitApp("/events/e1", NAV)).toEqual({ app: "イベント", icon: "calendar" });
    expect(resolveVisitApp("/chat/c1", NAV)).toEqual({ app: "チャット", icon: "message-square" });
  });

  it("matches the app landing path itself", () => {
    expect(resolveVisitApp("/members", NAV)).toEqual({ app: "運営メンバー・名簿", icon: "users" });
  });

  it("prefers the longest matching prefix over a shorter one", () => {
    const nav: NavEntry[] = [
      { label: " me", path: "/me", icon: "user", order: 1 },
      { label: "マイタスク", path: "/me/tasks", icon: "check-square", order: 2 },
    ];
    expect(resolveVisitApp("/me/tasks/t1", nav)).toEqual({ app: "マイタスク", icon: "check-square" });
  });

  it("does not match on a partial segment (boundary-aware)", () => {
    // "/eventsX" must NOT match "/events".
    expect(resolveVisitApp("/eventsX", NAV)).toBeNull();
  });

  it("ignores home and login", () => {
    expect(resolveVisitApp("/", NAV)).toBeNull();
    expect(resolveVisitApp("/login", NAV)).toBeNull();
  });

  it("returns null for a path owned by no registered app", () => {
    expect(resolveVisitApp("/unknown/thing", NAV)).toBeNull();
  });
});
