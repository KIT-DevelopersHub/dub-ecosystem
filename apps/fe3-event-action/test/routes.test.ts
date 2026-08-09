import { describe, it, expect } from "vitest";
import { eventRoutes, chatHref, routePaths } from "../src/lib/routes";

describe("route builders (test observations #10, #12)", () => {
  it("builds hierarchy paths", () => {
    expect(eventRoutes.list()).toBe("/events");
    expect(eventRoutes.detail("evt_1")).toBe("/events/evt_1");
    expect(eventRoutes.action("evt_1", "act_2")).toBe("/events/evt_1/actions/act_2");
    expect(eventRoutes.settings("evt_1")).toBe("/events/evt_1/settings");
    expect(eventRoutes.tasks("evt_1")).toBe("/events/evt_1/tasks");
  });

  it("chat is a query link, NOT a child route (#12)", () => {
    expect(chatHref("evt_1")).toBe("/chat?eventId=evt_1");
    // there is no /events/:eventId/chat route
    expect(Object.values(routePaths)).not.toContain("/events/:eventId/chat");
  });
});
