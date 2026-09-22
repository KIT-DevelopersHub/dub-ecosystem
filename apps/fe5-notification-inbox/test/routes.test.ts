import { describe, expect, it } from "vitest";
import { ROUTE_INBOX, resolveLinkUrl } from "../src/lib/routes";

describe("resolveLinkUrl", () => {
  it("returns null for empty/null (no navigation)", () => {
    expect(resolveLinkUrl(null)).toBeNull();
    expect(resolveLinkUrl(undefined)).toBeNull();
    expect(resolveLinkUrl("")).toBeNull();
  });

  it("honours known in-app paths", () => {
    expect(resolveLinkUrl("/tasks/task_123")).toEqual({ path: "/tasks/task_123", fellBack: false });
    expect(resolveLinkUrl("/notifications")).toEqual({ path: "/notifications", fellBack: false });
    expect(resolveLinkUrl("/events/event_1?tab=agenda")).toEqual({
      path: "/events/event_1?tab=agenda",
      fellBack: false,
    });
    // chat.mention / chat.dm deep-link into fe6-chat's channel route.
    expect(resolveLinkUrl("/chat/channels/chan_1")).toEqual({ path: "/chat/channels/chan_1", fellBack: false });
  });

  it("falls back to the inbox for unknown or external paths", () => {
    expect(resolveLinkUrl("/unknown/thing")).toEqual({ path: ROUTE_INBOX, fellBack: true });
    expect(resolveLinkUrl("https://evil.example/x")).toEqual({ path: ROUTE_INBOX, fellBack: true });
    expect(resolveLinkUrl("//evil.example")).toEqual({ path: ROUTE_INBOX, fellBack: true });
  });
});
