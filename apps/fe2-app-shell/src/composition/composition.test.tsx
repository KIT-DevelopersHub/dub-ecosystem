// W7a composition tests: the assembled FeatureModule array is shape-correct and
// registry-mergeable, and every feature client is genuinely fed by the shell
// api-client (the adapters translate onto ApiClient.request).
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, RequestInput } from "../lib/api-client.tsx";
import { buildRegistry } from "../modules/registry.tsx";
import { assembleFeatureModules, toIcon } from "./featureModules.tsx";
import {
  createChatApiClient,
  createGatewayResourceClient,
  createPrefixedHttpClient,
} from "./appClients.tsx";
import { EventProviders, TaskProviders } from "./moduleProviders.tsx";

/** Minimal ApiClient double: only `request` is exercised by the adapters. */
function fakeApi(): { api: ApiClient; calls: RequestInput[] } {
  const calls: RequestInput[] = [];
  const request = vi.fn(<TRes,>(input: RequestInput): Promise<TRes> => {
    calls.push(input);
    return Promise.resolve(undefined as TRes);
  });
  return { api: { request } as unknown as ApiClient, calls };
}

describe("assembleFeatureModules", () => {
  it("assembles the five features in canonical order", () => {
    const { api } = fakeApi();
    const modules = assembleFeatureModules(api);
    expect(modules.map((m) => m.id)).toEqual(["events", "tasks", "notifications", "chat", "admin"]);
  });

  it("merges into the shell registry with no duplicate route ownership", () => {
    const { api } = fakeApi();
    const registry = buildRegistry(assembleFeatureModules(api));
    const paths = registry.routes.map((r) => r.path);
    // core segments each feature owns
    expect(paths).toEqual(expect.arrayContaining(["/events", "/me/tasks", "/notifications", "/chat", "/admin/users"]));
    // no duplicates survived the flatten + ownership check
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("splices FE4's real nested task routes under the FE3 events detail tree", () => {
    const { api } = fakeApi();
    const registry = buildRegistry(assembleFeatureModules(api));
    const paths = registry.routes.map((r) => r.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "/events/:eventId/tasks",
        "/events/:eventId/tasks/board",
        "/events/:eventId/tasks/gantt",
        "/events/:eventId/tasks/:taskId",
      ]),
    );
    // the delegated (empty) FE3 slot is not duplicated
    expect(paths.filter((p) => p === "/events/:eventId/tasks")).toHaveLength(1);
  });

  it("builds nav sorted by shell-owned order (events first, admin last)", () => {
    const { api } = fakeApi();
    const registry = buildRegistry(assembleFeatureModules(api));
    const labels = registry.nav.map((n) => n.path);
    expect(labels[0]).toBe("/events");
    expect(labels.at(-1)).toBe("/admin/history");
    // every nav icon resolved to a valid IconName (no crash-on-unknown)
    for (const n of registry.nav) expect(typeof n.icon).toBe("string");
  });

  it("carries badge sources through for notifications and chat", () => {
    const { api } = fakeApi();
    const registry = buildRegistry(assembleFeatureModules(api));
    const withBadge = registry.nav.filter((n) => typeof n.badgeSource === "function").map((n) => n.path);
    expect(withBadge).toEqual(expect.arrayContaining(["/notifications", "/chat"]));
  });

  it("exposes a header widget for notifications", () => {
    const { api } = fakeApi();
    const registry = buildRegistry(assembleFeatureModules(api));
    expect(registry.headerWidgets.length).toBeGreaterThanOrEqual(1);
  });

  it("propagates FE5's module-level requiredPermissions onto every notifications route", () => {
    // Regression: adaptNotifications must carry notificationsModule's MODULE-LEVEL
    // perm (notif:inbox:self) so registry.flatten() ANDs it onto each route. Dropping
    // it let the preferences route be gated by prefs alone — a silent authz weaken.
    const { api } = fakeApi();
    const notifications = assembleFeatureModules(api).find((m) => m.id === "notifications");
    expect(notifications?.requiredPermissions).toContain("notif:inbox:self");

    const registry = buildRegistry(assembleFeatureModules(api));
    const prefs = registry.routes.find((r) => r.path === "/settings/notifications");
    expect(prefs?.requiredPermissions).toEqual(
      expect.arrayContaining(["notif:inbox:self", "notif:prefs:self"]),
    );
    const inbox = registry.routes.find((r) => r.path === "/notifications");
    expect(inbox?.requiredPermissions).toContain("notif:inbox:self");
  });
});

describe("toIcon", () => {
  it("maps feature icon strings onto the FE1 union and degrades safely", () => {
    expect(toIcon("list")).toBe("check-square");
    expect(toIcon("chat")).toBe("message-square");
    expect(toIcon("history")).toBe("file");
    expect(toIcon(undefined)).toBe("file");
    expect(toIcon("totally-unknown")).toBe("file");
  });
});

describe("app client adapters feed ApiClient.request", () => {
  it("prefixed HTTP client (FE3) adds the /api/v1 prefix to logical paths", async () => {
    const { api, calls } = fakeApi();
    const client = createPrefixedHttpClient(api);
    await client.get("/events", { include: "actions" });
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/v1/events", query: { include: "actions" } });
  });

  it("gateway resource client (FE5/FE7) passes absolute paths and drops null query", async () => {
    const { api, calls } = fakeApi();
    const client = createGatewayResourceClient(api);
    await client.get("/api/v1/identity/users", { q: "ada", cursor: undefined, archived: null as unknown as undefined });
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/v1/identity/users", query: { q: "ada" } });
    await client.delete("/api/v1/identity/roles/r_1");
    expect(calls[1]).toMatchObject({ method: "DELETE", path: "/api/v1/identity/roles/r_1" });
  });

  it("chat client (FE6) maps REST calls and batches user resolution", async () => {
    const { api, calls } = fakeApi();
    const chat = createChatApiClient(api);
    await chat.getWsTicket("ch_1" as never);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/v1/chat/channels/ch_1/ws-ticket" });

    await chat.listMessages({ channelId: "ch_1" as never, limit: 20 });
    expect(calls[1]).toMatchObject({ method: "GET", path: "/api/v1/chat/messages", query: { channelId: "ch_1", limit: 20 } });

    const empty = await chat.resolveUsers([]);
    expect(empty).toEqual([]);
    expect(calls).toHaveLength(2); // no request for an empty batch
  });
});

describe("runtime providers wrap their routes", () => {
  it("EventProviders mounts and passes children through", () => {
    const { api } = fakeApi();
    render(
      <EventProviders api={api}>
        <div data-testid="child">events-child</div>
      </EventProviders>,
    );
    expect(screen.getByTestId("child")).toHaveTextContent("events-child");
  });

  it("TaskProviders mounts and passes children through", () => {
    const { api } = fakeApi();
    render(
      <TaskProviders api={api}>
        <div data-testid="child">tasks-child</div>
      </TaskProviders>,
    );
    expect(screen.getByTestId("child")).toHaveTextContent("tasks-child");
  });
});
