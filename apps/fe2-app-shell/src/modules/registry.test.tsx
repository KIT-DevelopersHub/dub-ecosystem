import { describe, it, expect } from "vitest";
import { buildRegistry } from "./registry.tsx";
import type { FeatureModule } from "./types.tsx";

const Comp = () => <div />;
const lazy = () => Promise.resolve({ Component: Comp });

function mod(over: Partial<FeatureModule> & Pick<FeatureModule, "id">): FeatureModule {
  return { routes: [], nav: [], ...over };
}

describe("buildRegistry", () => {
  it("aggregates and sorts nav by order across modules", () => {
    const reg = buildRegistry([
      mod({ id: "chat", nav: [{ label: "Chat", path: "/chat", icon: "message-square", order: 30 }] }),
      mod({ id: "events", nav: [{ label: "Events", path: "/events", icon: "calendar", order: 10 }] }),
    ]);
    expect(reg.nav.map((n) => n.path)).toEqual(["/events", "/chat"]);
  });

  it("flattens nested child routes (nested delegation)", () => {
    const reg = buildRegistry([
      mod({
        id: "events",
        routes: [
          {
            path: "/events/:eventId",
            lazy,
            auth: "required",
            children: [{ path: "/events/:eventId/tasks", lazy, auth: "required" }],
          },
        ],
      }),
    ]);
    expect(reg.routes.map((r) => r.path)).toEqual(["/events/:eventId", "/events/:eventId/tasks"]);
  });

  it("merges module-level requiredPermissions onto each route", () => {
    const reg = buildRegistry([
      mod({
        id: "admin",
        requiredPermissions: ["identity:read"],
        routes: [{ path: "/admin/users", lazy, auth: "required", requiredPermissions: ["identity:admin"] }],
      }),
    ]);
    expect(reg.routes[0]!.requiredPermissions).toEqual(["identity:read", "identity:admin"]);
  });

  it("throws on duplicate route segment ownership", () => {
    expect(() =>
      buildRegistry([
        mod({ id: "events", routes: [{ path: "/shared", lazy, auth: "required" }] }),
        mod({ id: "tasks", routes: [{ path: "/shared", lazy, auth: "required" }] }),
      ]),
    ).toThrow(/duplicate ownership/);
  });

  it("throws on duplicate module id", () => {
    expect(() => buildRegistry([mod({ id: "events" }), mod({ id: "events" })])).toThrow(/id duplicated/);
  });

  it("collects headerWidgets", () => {
    const Widget = () => <span />;
    const reg = buildRegistry([mod({ id: "notifications", headerWidget: Widget })]);
    expect(reg.headerWidgets).toEqual([Widget]);
  });
});
