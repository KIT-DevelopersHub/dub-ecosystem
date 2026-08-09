import { describe, it, expect } from "vitest";
import {
  taskModule,
  eventTaskRoutes,
  mountTaskRoutesUnder,
  taskActionPlugin,
  registerTaskActionPlugin,
} from "../src/features/task-gantt/public";
import type { FeatureRoute } from "../src/contracts/spa-shell";
import type { ActionTypePlugin, ActionTypeRegistry } from "../src/contracts/event-action";

// Minimal in-test registry (mirrors FE3's createActionTypeRegistry contract) so we
// don't depend on the unmerged @dub/fe3-event-action package.
function makeRegistry(fallback: ActionTypePlugin): ActionTypeRegistry {
  const plugins = new Map<string, ActionTypePlugin>();
  return {
    register: (p) => void plugins.set(p.type, p),
    resolve: (t) => plugins.get(t) ?? fallback,
    list: () => [...plugins.values()],
    has: (t) => plugins.has(t),
  };
}

describe("FE4 public surface — FeatureModule (FE2 contract)", () => {
  it("taskModule owns the /me/tasks segment with nav + task:read guard", () => {
    expect(taskModule.id).toBe("tasks");
    expect(taskModule.routes).toHaveLength(1);
    const [me] = taskModule.routes;
    expect(me!.path).toBe("/me/tasks");
    expect(me!.auth).toBe("required");
    expect(me!.requiredPermissions).toEqual(["task:read"]);
    expect(taskModule.nav).toEqual([{ label: "マイタスク", path: "/me/tasks", icon: "check-square", order: 20 }]);
  });

  it("route lazy loaders resolve to a Component (FE2 lazy contract)", async () => {
    const mod = await taskModule.routes[0]!.lazy();
    expect(typeof mod.Component).toBe("function");
    const nested = await eventTaskRoutes[0]!.lazy();
    expect(typeof nested.Component).toBe("function");
  });

  it("event-scoped task routes cover list/board/gantt/detail under /events/:eventId", () => {
    expect(eventTaskRoutes.map((r) => r.path)).toEqual([
      "/events/:eventId/tasks",
      "/events/:eventId/tasks/board",
      "/events/:eventId/tasks/gantt",
      "/events/:eventId/tasks/:taskId",
    ]);
    for (const r of eventTaskRoutes) {
      expect(r.auth).toBe("required");
      expect(r.requiredPermissions).toEqual(["task:read"]);
    }
  });

  it("mountTaskRoutesUnder nests task routes via FeatureRoute.children (pure)", () => {
    const existingChild: FeatureRoute = {
      path: "/events/:eventId/settings",
      lazy: async () => ({ Component: () => null }),
      auth: "required",
    };
    const eventsRoute: FeatureRoute = {
      path: "/events/:eventId",
      lazy: async () => ({ Component: () => null }),
      auth: "required",
      children: [existingChild],
    };
    const merged = mountTaskRoutesUnder(eventsRoute);
    // input not mutated
    expect(eventsRoute.children).toEqual([existingChild]);
    // existing children preserved, task routes appended
    expect(merged.children).toHaveLength(1 + eventTaskRoutes.length);
    expect(merged.children!.slice(1)).toEqual(eventTaskRoutes);
  });
});

describe("FE4 public surface — ActionTypeRegistry plugin (FE3 contract)", () => {
  it("taskActionPlugin is a task_management plugin with a Panel component", () => {
    const p = taskActionPlugin();
    expect(p.type).toBe("task_management");
    expect(p.label).toBe("タスク管理");
    expect(p.icon).toBe("task");
    expect(typeof p.Panel).toBe("function");
  });

  it("registerTaskActionPlugin registers into FE3's registry", () => {
    const fallback = taskActionPlugin();
    const registry = makeRegistry({ ...fallback, type: "__fallback__" });
    expect(registry.has("task_management")).toBe(false);
    registerTaskActionPlugin(registry);
    expect(registry.has("task_management")).toBe(true);
    expect(registry.resolve("task_management").type).toBe("task_management");
    expect(registry.list().map((p) => p.type)).toContain("task_management");
  });
});
