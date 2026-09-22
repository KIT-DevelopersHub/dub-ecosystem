// Unit tests for buildPushDeepLink — the (resourceType, resourceId) -> dub:// route
// mapping carried in a push notification's data.deepLink. Route grammar must stay in
// sync with the mobile clients' parseDeepLink (mo1-ios/src/deeplink.ts).
import { describe, it, expect } from "vitest";
import { buildPushDeepLink } from "../src/push-deeplink";

describe("buildPushDeepLink", () => {
  it("maps typed resources to their dub:// route", () => {
    expect(buildPushDeepLink("task", "tsk_1")).toBe("dub://tasks/tsk_1");
    expect(buildPushDeepLink("event", "evt_1")).toBe("dub://events/evt_1");
    expect(buildPushDeepLink("action", "act_1")).toBe("dub://actions/act_1");
    expect(buildPushDeepLink("channel", "chan_1")).toBe("dub://chat/chan_1");
  });

  it("falls back to the inbox for untyped / unknown resources", () => {
    expect(buildPushDeepLink(null, null)).toBe("dub://inbox");
    expect(buildPushDeepLink("feedback", "fb_1")).toBe("dub://inbox");
    expect(buildPushDeepLink("notification", "ntf_1")).toBe("dub://inbox");
    expect(buildPushDeepLink(undefined, undefined)).toBe("dub://inbox");
  });

  it("falls back to the inbox when a typed resource has no id", () => {
    expect(buildPushDeepLink("task", null)).toBe("dub://inbox");
    expect(buildPushDeepLink("event", "")).toBe("dub://inbox");
  });

  it("url-encodes the id segment", () => {
    expect(buildPushDeepLink("channel", "a/b c")).toBe("dub://chat/a%2Fb%20c");
  });
});
