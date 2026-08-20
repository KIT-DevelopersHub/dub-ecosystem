// W7a composition tests: the assembled FeatureModule array is shape-correct and
// registry-mergeable, and every feature client is genuinely fed by the shell
// api-client (the adapters translate onto ApiClient.request).
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
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

  it("builds nav sorted by shell-owned order (events first)", () => {
    const { api } = fakeApi();
    const registry = buildRegistry(assembleFeatureModules(api));
    const labels = registry.nav.map((n) => n.path);
    // イベント(order 10)を先頭に固定。ランチャータイルは詳細ハブ(/event-hub)を開く
    // （/events 一覧ではない）。
    expect(labels[0]).toBe("/event-hub");
    // every nav icon resolved to a valid IconName (no crash-on-unknown)
    for (const n of registry.nav) expect(typeof n.icon).toBe("string");
  });

  it("運営メンバー・名簿 into ONE tile (名簿/参加届 off-launcher); ロール管理 an independent tile; 変更履歴 gone", () => {
    // 統合: 運営メンバー(member-service) + 名簿(FE7 /admin/users) + 参加届/回答(participation) を
    // 1 タイル「運営メンバー・名簿」(/members) に合体し、共有サブナビ(MemberRosterNav)で横断する。
    // ロール管理(/admin/roles) はそこから括り出して独立ランチャータイルに戻す。変更履歴(/admin/history)
    // の UI は完全撤去（ルートごと削除）。メールアドレス管理(/admin/email-routing) は従前どおり未登録。
    const { api } = fakeApi();
    const registry = buildRegistry(assembleFeatureModules(api));
    const navPaths = registry.nav.map((n) => n.path);
    // 統合アプリの単一タイル
    expect(navPaths).toContain("/members");
    const membersNav = registry.nav.find((n) => n.path === "/members");
    expect(membersNav?.label).toBe("運営メンバー・名簿");
    // ロール管理は独立タイルとして復活
    expect(navPaths).toContain("/admin/roles");
    const rolesNav = registry.nav.find((n) => n.path === "/admin/roles");
    expect(rolesNav?.label).toBe("ロール管理");
    expect(rolesNav?.appId).toBe("admin");
    // 名簿/参加届/回答 は統合タイル内サブナビから開くので個別タイルは無い。変更履歴タイルは消滅。
    expect(navPaths).not.toContain("/admin/users");
    expect(navPaths).not.toContain("/admin/history");
    expect(navPaths).not.toContain("/participation");
    expect(navPaths).not.toContain("/participation/list");
    expect(navPaths).not.toContain("/admin/email-routing");
    // 他アプリは絶対に減らさない（イベントタイルは詳細ハブ /event-hub を開く）
    expect(navPaths).toEqual(
      expect.arrayContaining([
        "/event-hub",
        "/me/tasks",
        "/gantt",
        "/notifications",
        "/chat",
        "/mail",
        "/usage",
        "/members",
        "/driveshare",
        "/admin/roles",
      ]),
    );
    // admin/participation routes（名簿/ロール/参加届/回答）は保持（統合ナビ + deep-link 生存）。
    // 変更履歴ルート(/admin/history) は撤去済みなので存在しないこと。
    const routePaths = registry.routes.map((r) => r.path);
    expect(routePaths).toEqual(
      expect.arrayContaining([
        "/admin/users",
        "/admin/roles",
        "/participation",
        "/participation/list",
        "/members",
        "/events",
        "/events/:eventId/tasks/gantt",
      ]),
    );
    expect(routePaths).not.toContain("/admin/history");
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

  it("toggleReaction normalizes the server's { messageId, reactions: Record } to Reaction[]", async () => {
    const api = {
      request: (<TRes,>(_input: RequestInput): Promise<TRes> =>
        Promise.resolve({ messageId: "m1", reactions: { "\u{1F389}": ["u1", "u2"] } } as TRes)),
    } as unknown as ApiClient;
    const chat = createChatApiClient(api);
    const res = await chat.toggleReaction("m1" as never, { emoji: "\u{1F389}" });
    expect(res.messageId).toBe("m1");
    expect(Array.isArray(res.reactions)).toBe(true);
    expect(res.reactions).toEqual([{ emoji: "\u{1F389}", userIds: ["u1", "u2"] }]);
  });

  it("postMessage composes { message, clientTempId } from the server's bare Message", async () => {
    // Regression: the server returns the created Message (bare). FE6's optimistic layer
    // reconciles by { message, clientTempId } — if the adapter passes the bare Message
    // through, res.clientTempId/res.message are undefined and the send shows
    // "送信に失敗しました" despite a 201. The adapter must re-attach the sent clientTempId.
    const serverMessage = { id: "m1", channelId: "c1", body: "hi", authorId: "u1" };
    const api = {
      request: (<TRes,>(_input: RequestInput): Promise<TRes> => Promise.resolve(serverMessage as TRes)),
    } as unknown as ApiClient;
    const chat = createChatApiClient(api);
    const res = await chat.postMessage({ channelId: "c1" as never, body: "hi", clientTempId: "tmp-123" });
    expect(res.clientTempId).toBe("tmp-123");
    expect(res.message).toMatchObject({ id: "m1", body: "hi" });
  });
});

describe("runtime providers wrap their routes", () => {
  it("EventProviders mounts and passes children through", async () => {
    const { api } = fakeApi();
    // EventProviders reads the shell auth (useMe) AND the shell router
    // (useNavigate/useParams/useRouterState → the FE3 NavigationProvider it now
    // injects), so it must mount under both, exactly like the real shell path.
    const authApi = { auth: { me: () => Promise.resolve(TASK_ME) } } as unknown as ApiClient;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rootRoute = createRootRoute({
      component: () => (
        <EventProviders api={api}>
          <div data-testid="child">events-child</div>
        </EventProviders>
      ),
    });
    const router = createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ["/event-hub"] }),
    });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider api={authApi}>
          <RouterProvider router={router} />
        </AuthProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("child")).toHaveTextContent("events-child"));
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
