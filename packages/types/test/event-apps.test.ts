import { describe, it, expect } from "vitest";
import { appRegistry, event } from "../src/index";

describe("per-event enabled apps", () => {
  it("a legacy event (no setting) resolves to every app — today's behaviour", () => {
    expect(event.resolveEnabledApps(null)).toEqual([...appRegistry.APP_IDS]);
    expect(event.resolveEnabledApps(undefined)).toEqual([...appRegistry.APP_IDS]);
  });

  const toggles = (apps: string[]) => apps.filter((a) => event.isEventToggleableApp(a));
  const orgWide = appRegistry.APP_IDS.filter((a) => !event.isEventToggleableApp(a));

  it("new events default to イベント・ガントチャート・ロール管理, org-wide apps always on", () => {
    const r = event.resolveEnabledApps(event.EVENT_DEFAULT_ENABLED_APPS);
    expect(toggles(r)).toEqual(["events", "gantt", "admin"]);
    for (const id of ["mail", "chat", "notifications", "calendar"]) expect(r).toContain(id);
    expect(r.filter((a) => !event.isEventToggleableApp(a))).toEqual(orgWide);
  });

  it("always keeps イベント on and drops unknown ids", () => {
    expect(toggles(event.resolveEnabledApps(["members", "bogus"]))).toEqual(["events", "members"]);
  });

  it("every toggleable app is registered", () => {
    for (const id of event.EVENT_TOGGLEABLE_APPS) expect(appRegistry.isCanonicalAppId(id)).toBe(true);
  });

  it("every default / always-on id is a registered app", () => {
    for (const id of [...event.EVENT_DEFAULT_ENABLED_APPS, ...event.EVENT_ALWAYS_ENABLED_APPS]) {
      expect(appRegistry.isCanonicalAppId(id)).toBe(true);
    }
    expect(event.isEnabledAppList(["gantt", "x"])).toBe(false);
  });
});

describe("運営メンバー per event", () => {
  it("scopeOverviewToEvent keeps the event's staff and 班 only", async () => {
    const { member } = await import("../src/index");
    const m = (id: string, teamIds: string[]) => ({ id, teamIds }) as unknown as import("../src/member").Member;
    const t = (id: string) => ({ id, key: id, name: id, color: null, description: null });
    const scoped = member.scopeOverviewToEvent(
      { teams: [t("a"), t("b")], members: [m("p1", ["a", "b"]), m("p2", ["a"])] },
      { eventId: "e", personIds: ["p1"], teamIds: ["b"] },
    );
    expect(scoped.teams.map((x) => x.id)).toEqual(["b"]);
    expect(scoped.members.map((x) => [x.id, x.teamIds])).toEqual([["p1", ["b"]]]);
    expect(member.isEventScopeId("acd75449-c875-4c13-83d8-2dd8f8ce8a33")).toBe(true);
    expect(member.isEventScopeId("x;drop")).toBe(false);
  });
});
