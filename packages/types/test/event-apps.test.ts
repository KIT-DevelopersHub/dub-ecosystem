import { describe, it, expect } from "vitest";
import { appRegistry, event } from "../src/index";

describe("per-event enabled apps", () => {
  it("a legacy event (no setting) resolves to every app — today's behaviour", () => {
    expect(event.resolveEnabledApps(null)).toEqual([...appRegistry.APP_IDS]);
    expect(event.resolveEnabledApps(undefined)).toEqual([...appRegistry.APP_IDS]);
  });

  it("new events default to イベント・ガントチャート・ロール管理", () => {
    expect(event.resolveEnabledApps(event.EVENT_DEFAULT_ENABLED_APPS)).toEqual(["events", "gantt", "admin"]);
  });

  it("always keeps イベント on and drops unknown ids", () => {
    expect(event.resolveEnabledApps(["members", "bogus"])).toEqual(["events", "members"]);
  });

  it("every default / always-on id is a registered app", () => {
    for (const id of [...event.EVENT_DEFAULT_ENABLED_APPS, ...event.EVENT_ALWAYS_ENABLED_APPS]) {
      expect(appRegistry.isCanonicalAppId(id)).toBe(true);
    }
    expect(event.isEnabledAppList(["gantt", "x"])).toBe(false);
  });
});
