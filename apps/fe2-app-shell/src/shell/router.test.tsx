import { describe, it, expect } from "vitest";
import { toTanstackPath, createShellRouter } from "./router.tsx";
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
    expect(paths).toContain("/auth/callback");
    expect(paths).toContain("/events");
  });
});
