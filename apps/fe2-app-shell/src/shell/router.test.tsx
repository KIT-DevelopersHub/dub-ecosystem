import { describe, it, expect } from "vitest";
import { toTanstackPath, createShellRouter, appSegment } from "./router.tsx";
import { buildRegistry } from "../modules/registry.tsx";
import type { ApiClient } from "../lib/api-client.tsx";

describe("toTanstackPath", () => {
  it("converts :param to $param", () => {
    expect(toTanstackPath("/events/:eventId")).toBe("/events/$eventId");
    expect(toTanstackPath("/events/:eventId/actions/:actionId")).toBe("/events/$eventId/actions/$actionId");
  });
  it("converts trailing wildcard /* to /$", () => {
    expect(toTanstackPath("/admin/*")).toBe("/admin/$");
  });
});

// P14 delight UX: ShellRouteContent keys its crossfade wrapper by `appSegment`, so
// switching apps (a launcher tile) remounts + fades, while navigating within the
// same app does not (state/scroll stays, no fade replay).
describe("appSegment", () => {
  it("takes the first path segment as the app identity", () => {
    expect(appSegment("/chat")).toBe("chat");
    expect(appSegment("/chat/settings")).toBe("chat");
    expect(appSegment("/tasks/evt_1/board")).toBe("tasks");
  });
  it("treats the root path as a stable 'home' app", () => {
    expect(appSegment("/")).toBe("home");
    expect(appSegment("")).toBe("home");
  });
  it("is stable across sub-navigation within the same app (no remount)", () => {
    expect(appSegment("/mail/inbox")).toBe(appSegment("/mail/sent"));
  });
  it("differs across a real app switch (triggers the fade)", () => {
    expect(appSegment("/tasks")).not.toBe(appSegment("/chat"));
  });
});

describe("createShellRouter", () => {
  it("builds a router from the shell routes plus feature routes", () => {
    const api = {} as ApiClient;
    const registry = buildRegistry([
      {
        id: "events",
        nav: [{ label: "Events", path: "/events", icon: "calendar", order: 10 }],
        routes: [{ path: "/events", lazy: () => Promise.resolve({ Component: () => null }), auth: "required" }],
      },
    ]);
    const router = createShellRouter(api, registry);
    expect(router).toBeDefined();
    const paths = Object.keys(router.routesByPath);
    expect(paths).toContain("/login");
    expect(paths).not.toContain("/auth/callback");
    expect(paths).toContain("/events");
  });
});
