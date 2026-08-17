// W7a composition tests: the assembled FeatureModule array is shape-correct and
// registry-mergeable, and every feature client is genuinely fed by the shell
// api-client (the adapters translate onto ApiClient.request).
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { gateway } from "@dub/types";
import { useTaskRoute } from "@dub/fe4-task-gantt/src/routes/taskRoutes";
import type { ApiClient, RequestInput } from "../lib/api-client.tsx";
import { AuthProvider } from "../auth/AuthProvider.tsx";
import { buildRegistry } from "../modules/registry.tsx";
import { assembleFeatureModules, toIcon } from "./featureModules.tsx";
import {
  createChatApiClient,
  createGatewayResourceClient,
  createPrefixedHttpClient,
} from "./appClients.tsx";
import { EventProviders, TaskProviders } from "./moduleProviders.tsx";

/** /me session used to drive TaskProviders' TaskRouteContext wiring. */
const TASK_ME: gateway.MeResponse = {
  user: { id: "usr_me", displayName: "私", avatarUrl: null },
  orgId: "org_devhub",
  permissions: ["task:read"],
  sessionExpiresAt: Date.now() + 60_000,
};

/** Render `ui` under a resolved AuthProvider + TaskProviders (the shell path). */
function renderTasksWithAuth(taskApi: ApiClient, ui: ReactNode) {
  const authApi = { auth: { me: () => Promise.resolve(TASK_ME) } } as unknown as ApiClient;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider api={authApi}>
        <TaskProviders api={taskApi}>{ui}</TaskProviders>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

function TaskRouteProbe() {
  const { currentUserId, permissions } = useTaskRoute();
  return (
    <>
      <div data-testid="uid">{currentUserId ?? "none"}</div>
      <div data-testid="perms">{(permissions ?? []).join(",")}</div>
    </>
  );
}

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
  it("assembles the features in canonical order", () => {
    const { api } = fakeApi();
    const modules = assembleFeatureModules(api);
    expect(modules.map((m) => m.id)).toEqual([
      "events",
      "tasks",
      "gantt",
      "notifications",
      "chat",
      "mail",
      "usage",
      "members",
      "participation",
      "driveshare",
      "admin",
    ]);
  });

  it("merges into the shell registry with no duplicate route ownership", () => {
    const { api } = fakeApi();
    const registry = buildRegistry(assembleFeatureModules(api));
    const paths = registry.routes.map((r) => r.path);
    // core segments each feature owns
    expect(paths).toEqual(expect.arrayContaining(["/events", "/me/tasks", "/gantt", "/notifications", "/chat", "/mail", "/usage", "/members", "/participation", "/driveshare", "/admin/users"]));
    // no duplicates survived the flatten + ownership check
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("gates the mail routes: /mail on mail:read, /mail/compose on mail:send", () => {
    const { api } = fakeApi();
    const registry = buildRegistry(assembleFeatureModules(api));
    const inbox = registry.routes.find((r) => r.path === "/mail");
    const compose = registry.routes.find((r) => r.path === "/mail/compose");
    expect(inbox?.requiredPermissions).toContain("mail:read");
    expect(inbox?.auth).toBe("required");
    expect(compose?.requiredPermissions).toContain("mail:send");
    expect(compose?.auth).toBe("required");
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
    // イベント(order 10)を先頭に固定。末尾は admin の最後のツール 変更履歴(/admin/history)。
    expect(labels[0]).toBe("/events");
    expect(labels.at(-1)).toBe("/admin/history");
    // every nav icon resolved to a valid IconName (no crash-on-unknown)
    for (const n of registry.nav) expect(typeof n.icon).toBe("string");
  });

  it("removes only メールアドレス管理 from nav; keeps every other app (events + 変更履歴 復活)", () => {
    // ユーザー明示承認で launcher/ナビから外すのは メールアドレス管理(/admin/email-routing) のみ。
    // イベント(/events)・変更履歴(/admin/history) は誤撤去のため復活。他アプリは絶対に減らさない。
    const { api } = fakeApi();
    const registry = buildRegistry(assembleFeatureModules(api));
    const navPaths = registry.nav.map((n) => n.path);
    // 意図的撤去のままなのは email-routing だけ
    expect(navPaths).not.toContain("/admin/email-routing");
    // 復活した2つは nav にある
    expect(navPaths).toContain("/events");
    expect(navPaths).toContain("/admin/history");
    // 残す他アプリは全て nav にある
    expect(navPaths).toEqual(
      expect.arrayContaining([
        "/events",
        "/me/tasks",
        "/gantt",
        "/notifications",
        "/chat",
        "/mail",
        "/usage",
        "/members",
        "/driveshare",
        "/admin/users",
        "/admin/roles",
        "/admin/history",
      ]),
    );
    // イベント routes も保持（ガント/タスクの event-scoped 動線が依存 + deep-link 生存）
    const routePaths = registry.routes.map((r) => r.path);
    expect(routePaths).toEqual(expect.arrayContaining(["/admin/users", "/admin/roles", "/admin/history", "/events", "/events/:eventId/tasks/gantt"]));
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

  it("chat client unwraps the Paginated { items } envelope to an array (channels/unread/users)", async () => {
    // Regression: the server returns common.Paginated<T> = { items, nextCursor } for
    // channels/unread/users. Returning that object as-is made groupChannels drop it
    // (non-array guard) → an empty sidebar despite /chat/channels 200. Must unwrap.
    const envelope = {
      "/api/v1/chat/channels": { items: [{ id: "c1", name: "general" }], nextCursor: null },
      "/api/v1/chat/unread": { items: [{ channelId: "c1", unreadCount: 2 }] },
      "/api/v1/identity/users": { items: [{ id: "u1" }, { id: "u2" }], nextCursor: null },
    } as Record<string, unknown>;
    const api = {
      request: (<TRes,>(input: RequestInput): Promise<TRes> =>
        Promise.resolve((envelope[input.path] ?? []) as TRes)),
    } as unknown as ApiClient;
    const chat = createChatApiClient(api);

    const channels = await chat.listChannels();
    expect(Array.isArray(channels)).toBe(true);
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ id: "c1", name: "general" });

    const unread = await chat.listUnread();
    expect(Array.isArray(unread)).toBe(true);
    expect(unread).toHaveLength(1);

    const users = await chat.resolveUsers(["u1", "u2"] as never);
    expect(Array.isArray(users)).toBe(true);
    expect(users).toHaveLength(2);
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

  it("TaskProviders mounts and passes children through", async () => {
    const { api } = fakeApi();
    renderTasksWithAuth(api, <div data-testid="child">tasks-child</div>);
    await waitFor(() => expect(screen.getByTestId("child")).toHaveTextContent("tasks-child"));
  });

  // Regression (mytasks revamp): the shell must feed the standalone マイタスク route
  // (`/me/tasks`) its currentUserId + permissions via TaskRouteContext. Without this
  // wiring the route renders "ユーザー情報を読み込んでいます…" forever — the app is
  // dead-on-arrival in the real shell even though the fe4 demo works.
  it("TaskProviders feeds the マイタスク route its currentUserId + permissions from /me", async () => {
    const { api } = fakeApi();
    renderTasksWithAuth(api, <TaskRouteProbe />);
    // fail-closed while /me is loading
    expect(screen.getByTestId("uid").textContent).toBe("none");
    await waitFor(() => expect(screen.getByTestId("uid").textContent).toBe("usr_me"));
    expect(screen.getByTestId("perms").textContent).toBe("task:read");
  });
});
