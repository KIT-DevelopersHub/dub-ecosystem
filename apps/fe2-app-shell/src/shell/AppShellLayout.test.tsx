import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { gateway } from "@dub/types";
import type { ApiClient } from "../lib/api-client.tsx";
import { AuthProvider } from "../auth/AuthProvider.tsx";
import { AppShellLayout, truncateEmail } from "./AppShellLayout.tsx";
import { useUiStore } from "../store/uiStore.tsx";
import type { NavEntry } from "../modules/types.tsx";

const ME: gateway.MeResponse = {
  user: { id: "usr_1", displayName: "Kota", avatarUrl: null, email: "kota@developershub.jp" },
  orgId: "org_devhub",
  permissions: [],
  sessionExpiresAt: Date.now() + 60_000,
};

function api(): ApiClient {
  return { auth: { me: () => Promise.resolve(ME) } } as unknown as ApiClient;
}

const NAV: NavEntry[] = [
  { label: "Events", path: "/events", icon: "calendar", order: 10 },
  { label: "Chat", path: "/chat", icon: "message-circle", order: 20, badgeSource: () => 5 },
];

function Widget() {
  return <span data-testid="header-widget">bell</span>;
}

function renderShell(onNavigate?: (p: string) => void, onLogout?: () => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider api={api()}>
        <AppShellLayout
          navEntries={NAV}
          headerWidgets={[Widget]}
          {...(onNavigate ? { onNavigate } : {})}
          {...(onLogout ? { onLogout } : {})}
        >
          <div data-testid="outlet">content</div>
        </AppShellLayout>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("AppShellLayout", () => {
  beforeEach(() => useUiStore.setState({ sidebarOpen: true, theme: "system" }));

  it("shows DevHub as the primary brand with the signed-in email small beside it", async () => {
    renderShell();
    // Brand-first header: "DevHub" is the primary label (and the home导线) and is
    // ALWAYS present; the account email rides alongside as the secondary label once
    // /me resolves — both are shown (the email no longer replaces the brand).
    const brand = screen.getByTestId("fe2-brand-home");
    expect(brand).toHaveTextContent("DevHub");
    const account = await screen.findByTestId("fe2-header-account");
    expect(account).toHaveTextContent("kota@developershub.jp");
    expect(screen.getByTestId("fe2-brand-home")).toHaveTextContent("DevHub");
  });

  it("navigates home when the DevHub brand is clicked (logo = home导线)", async () => {
    const onNavigate = vi.fn();
    renderShell(onNavigate);
    await userEvent.click(screen.getByTestId("fe2-brand-home"));
    expect(onNavigate).toHaveBeenCalledWith("/");
  });

  it("keeps the brand title when unauthenticated (no /me user)", async () => {
    const anonApi = { auth: { me: () => Promise.resolve(null) } } as unknown as ApiClient;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider api={anonApi}>
          <AppShellLayout navEntries={NAV}>
            <div data-testid="outlet">content</div>
          </AppShellLayout>
        </AuthProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("DevHub")).toBeInTheDocument();
  });

  it("truncateEmail keeps short addresses and elides long local parts, preserving the domain", () => {
    expect(truncateEmail("a@b.jp")).toBe("a@b.jp");
    const long = "an.extremely.long.local.part.address@developershub.jp";
    const out = truncateEmail(long);
    expect(out.length).toBeLessThanOrEqual(30);
    expect(out).toContain("…");
    expect(out.endsWith("@developershub.jp")).toBe(true);
  });

  it("renders header widget slot and routed content; tools live behind the launcher", async () => {
    renderShell();
    expect(screen.getByTestId("header-widget")).toBeInTheDocument();
    expect(screen.getByTestId("outlet")).toBeInTheDocument();
    // No persistent left rail: tool labels are hidden until the launcher opens.
    expect(screen.queryByText("Events")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("fe2-app-launcher-trigger"));
    expect(screen.getByText("Events")).toBeInTheDocument();
    expect(screen.getByText("Chat")).toBeInTheDocument();
  });

  it("hides アカウント設定 behind the 設定 (⚙) menu, opening the dialog (with nested パスワード変更) from inside it", async () => {
    // The self-settings导线 only mounts when a shared api-client is wired (showAccount),
    // so this case passes `api` to the layout — unlike renderShell().
    const changePassword = vi.fn(() => Promise.resolve());
    const shellApi = {
      auth: { me: () => Promise.resolve(ME), changePassword, updateProfile: vi.fn(() => Promise.resolve({ displayName: ME.user.displayName, avatarUrl: null })) },
    } as unknown as ApiClient;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <AuthProvider api={shellApi}>
            <AppShellLayout navEntries={NAV} api={shellApi} onNavigate={vi.fn()} onLogout={vi.fn()}>
              <div data-testid="outlet">content</div>
            </AppShellLayout>
          </AuthProvider>
        </ToastProvider>
      </QueryClientProvider>,
    );
    // The account-settings trigger is not bare in the header — it lives inside the 設定
    // dropdown. Closed menu => the item is not shown.
    expect(await screen.findByTestId("fe2-settings-menu-trigger")).toBeInTheDocument();
    expect(screen.queryByTestId("fe2-account-settings-open")).not.toBeInTheDocument();
    // Open 設定 -> アカウント設定 appears; clicking it opens the account dialog. パスワード変更
    // is unified INSIDE that dialog (a パスワードを変更 button opening the existing dialog).
    await userEvent.click(screen.getByTestId("fe2-settings-menu-trigger"));
    const item = screen.getByTestId("fe2-account-settings-open");
    expect(item).toHaveTextContent("アカウント設定");
    await userEvent.click(item);
    expect(await screen.findByTestId("fe2-account-settings")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("fe2-account-password-open"));
    expect(await screen.findByTestId("fe2-change-password")).toBeInTheDocument();
  });

  it("puts ログアウト inside the 設定 menu as a danger item below アカウント設定", async () => {
    const shellApi = {
      auth: { me: () => Promise.resolve(ME), changePassword: vi.fn(() => Promise.resolve()), updateProfile: vi.fn(() => Promise.resolve({ displayName: ME.user.displayName, avatarUrl: null })) },
    } as unknown as ApiClient;
    const onLogout = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <AuthProvider api={shellApi}>
            <AppShellLayout navEntries={NAV} api={shellApi} onNavigate={vi.fn()} onLogout={onLogout}>
              <div data-testid="outlet">content</div>
            </AppShellLayout>
          </AuthProvider>
        </ToastProvider>
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByTestId("fe2-settings-menu-trigger"));
    // Both items present; logout is danger-toned and ordered AFTER account settings.
    const items = screen.getAllByRole("menuitem").map((el) => el.getAttribute("data-testid"));
    expect(items).toEqual(["fe2-account-settings-open", "fe2-logout"]);
    const logout = screen.getByTestId("fe2-logout");
    expect(logout).toHaveAttribute("data-tone", "danger");
    // A separator divides the safe settings from the 離脱 action.
    expect(screen.getByRole("separator")).toBeInTheDocument();
    await userEvent.click(logout);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("renders injected nav badge from badgeSource inside the launcher", async () => {
    renderShell();
    await userEvent.click(screen.getByTestId("fe2-app-launcher-trigger"));
    // badgeSource() -> AppLauncherItem.badgeCount -> @dub/ui Badge on the tile.
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("calls onNavigate on launcher tile click and onLogout from the 設定 menu", async () => {
    const onNavigate = vi.fn();
    const onLogout = vi.fn();
    renderShell(onNavigate, onLogout);
    await userEvent.click(screen.getByTestId("fe2-app-launcher-trigger"));
    await userEvent.click(screen.getByText("Events"));
    expect(onNavigate).toHaveBeenCalledWith("/events");
    // ログアウトはヘッダに剥き出しではなく設定(⚙)メニュー内に移動した。開いてから押す。
    expect(screen.queryByTestId("fe2-logout")).not.toBeInTheDocument();
    await userEvent.click(await screen.findByTestId("fe2-settings-menu-trigger"));
    await userEvent.click(screen.getByTestId("fe2-logout"));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("closes the launcher after selecting a tool", async () => {
    renderShell(vi.fn());
    await userEvent.click(screen.getByTestId("fe2-app-launcher-trigger"));
    expect(screen.getByText("Events")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Events"));
    expect(screen.queryByText("Events")).not.toBeInTheDocument();
  });

  // Member release-gating (社長決定 2026-08-14, lib/releaseGate). Apps are NEVER removed
  // from the launcher (消さない); an unpublished app is greyed + disabled for general
  // members, while ONLY full admins (identity:admin) bypass the gate and see every app
  // active — non-admin operator roles are gated like members (#255, 2026-08-17).
  const GATED_NAV: NavEntry[] = [
    { label: "メール", path: "/mail", icon: "inbox", order: 45, appId: "mail" },
    { label: "イベント", path: "/events", icon: "calendar", order: 10, appId: "events" },
  ];

  it("greys out unpublished apps for a general member but keeps the tile (消さない)", async () => {
    // member perms: identity:read only -> no dangerous permission -> not privileged.
    const me: gateway.MeResponse = { ...ME, permissions: ["identity:read", "mail:read"] };
    const memberApi = { auth: { me: () => Promise.resolve(me) } } as unknown as ApiClient;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider api={memberApi}>
          <AppShellLayout navEntries={GATED_NAV} onNavigate={vi.fn()}>
            <div data-testid="outlet">content</div>
          </AppShellLayout>
        </AuthProvider>
      </QueryClientProvider>,
    );
    const trigger = await screen.findByTestId("fe2-app-launcher-trigger");
    await userEvent.click(trigger);
    // Both tiles are still present — nothing is removed.
    const mail = screen.getByTestId("fe2-app-launcher-item-mail");
    const events = screen.getByTestId("fe2-app-launcher-item-events");
    // メール is member-published -> active; イベント is not -> greyed + disabled + tooltip.
    expect(mail).toBeEnabled();
    expect(events).toBeDisabled();
    expect(events).toHaveAttribute("title", "準備中（メンバー未公開）");
  });

  it("ENABLES an unpublished app for a non-admin once ロール管理 grants app:<id>:view (#270 fix)", async () => {
    // organizer-like: not admin, holds event:read AND the per-app grant app:events:view.
    // Before the fix the release gate greyed events (not member-published) despite the
    // grant; now the grant releases it. requiredPermissions mirror the real nav (domain +
    // per-app) so the tile only enables when BOTH are held.
    const me: gateway.MeResponse = { ...ME, permissions: ["identity:read", "event:read", "app:events:view"] };
    const grantedApi = { auth: { me: () => Promise.resolve(me) } } as unknown as ApiClient;
    const nav: NavEntry[] = [
      { label: "メール", path: "/mail", icon: "inbox", order: 45, appId: "mail" },
      { label: "イベント", path: "/events", icon: "calendar", order: 10, appId: "events", requiredPermissions: ["event:read", "app:events:view"] },
    ];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider api={grantedApi}>
          <AppShellLayout navEntries={nav} onNavigate={vi.fn()}>
            <div data-testid="outlet">content</div>
          </AppShellLayout>
        </AuthProvider>
      </QueryClientProvider>,
    );
    const trigger = await screen.findByTestId("fe2-app-launcher-trigger");
    await userEvent.click(trigger);
    // granted -> active + clickable (the reported bug: was disabled).
    expect(screen.getByTestId("fe2-app-launcher-item-events")).toBeEnabled();
  });

  it("re-greys the app when the per-app grant is revoked (OFF)", async () => {
    // same viewer WITHOUT app:events:view -> release-gated again.
    const me: gateway.MeResponse = { ...ME, permissions: ["identity:read", "event:read"] };
    const revokedApi = { auth: { me: () => Promise.resolve(me) } } as unknown as ApiClient;
    const nav: NavEntry[] = [
      { label: "イベント", path: "/events", icon: "calendar", order: 10, appId: "events", requiredPermissions: ["event:read", "app:events:view"] },
    ];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider api={revokedApi}>
          <AppShellLayout navEntries={nav} onNavigate={vi.fn()}>
            <div data-testid="outlet">content</div>
          </AppShellLayout>
        </AuthProvider>
      </QueryClientProvider>,
    );
    const trigger = await screen.findByTestId("fe2-app-launcher-trigger");
    await userEvent.click(trigger);
    expect(screen.getByTestId("fe2-app-launcher-item-events")).toBeDisabled();
  });

  it("does not navigate when a member clicks a greyed (unpublished) tile", async () => {
    const me: gateway.MeResponse = { ...ME, permissions: ["identity:read", "mail:read"] };
    const memberApi = { auth: { me: () => Promise.resolve(me) } } as unknown as ApiClient;
    const onNavigate = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider api={memberApi}>
          <AppShellLayout navEntries={GATED_NAV} onNavigate={onNavigate}>
            <div data-testid="outlet">content</div>
          </AppShellLayout>
        </AuthProvider>
      </QueryClientProvider>,
    );
    const trigger = await screen.findByTestId("fe2-app-launcher-trigger");
    await userEvent.click(trigger);
    await userEvent.click(screen.getByTestId("fe2-app-launcher-item-events"));
    expect(onNavigate).not.toHaveBeenCalled();
    // The published tile still navigates.
    await userEvent.click(screen.getByTestId("fe2-app-launcher-item-mail"));
    expect(onNavigate).toHaveBeenCalledWith("/mail");
  });

  it("a full admin (identity:admin) bypasses the gate: every app is active", async () => {
    // holds identity:admin -> privileged -> no greying (#255 admin-only bypass).
    const me: gateway.MeResponse = { ...ME, permissions: ["identity:admin"] };
    const adminApi = { auth: { me: () => Promise.resolve(me) } } as unknown as ApiClient;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider api={adminApi}>
          <AppShellLayout navEntries={GATED_NAV} onNavigate={vi.fn()}>
            <div data-testid="outlet">content</div>
          </AppShellLayout>
        </AuthProvider>
      </QueryClientProvider>,
    );
    const trigger = await screen.findByTestId("fe2-app-launcher-trigger");
    await userEvent.click(trigger);
    expect(screen.getByTestId("fe2-app-launcher-item-mail")).toBeEnabled();
    expect(screen.getByTestId("fe2-app-launcher-item-events")).toBeEnabled();
  });

  // Permission gate: an app whose requiredPermissions the viewer lacks is greyed for
  // EVERYONE (privileged included), matching the route's requiredPermissions guard
  // (router.tsx RequirePermission → 403). All GATED apps are published here so the
  // release gate is out of the way and the permission gate is what's under test.
  const PERM_NAV: NavEntry[] = [
    { label: "ロール管理", path: "/admin/roles", icon: "shield", order: 50, appId: "mail", requiredPermissions: ["identity:admin"] },
    { label: "メール", path: "/mail", icon: "inbox", order: 45, appId: "mail" },
  ];

  it("greys an app whose requiredPermissions a privileged viewer still lacks", async () => {
    // Holds mail:admin (both apps use the published appId "mail", so the release gate is
    // out of the way) but NOT identity:admin, so the identity:admin-gated ロール管理 must
    // grey via the permission gate — same as its route 403ing.
    const me: gateway.MeResponse = { ...ME, permissions: ["mail:admin", "mail:read"] };
    const maintApi = { auth: { me: () => Promise.resolve(me) } } as unknown as ApiClient;
    const onNavigate = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider api={maintApi}>
          <AppShellLayout navEntries={PERM_NAV} onNavigate={onNavigate}>
            <div data-testid="outlet">content</div>
          </AppShellLayout>
        </AuthProvider>
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByTestId("fe2-app-launcher-trigger"));
    const roles = screen.getByTestId("fe2-app-launcher-item-admin-roles");
    expect(roles).toBeDisabled();
    expect(roles).toHaveAttribute("title", "権限がありません（アクセス不可）");
    expect(screen.getByTestId("fe2-app-launcher-item-mail")).toBeEnabled();
    // Greyed permission-gated tile does not navigate.
    await userEvent.click(roles);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("sorts usable apps first and greyed apps last, preserving order within each group", async () => {
    // member: only メール is published + within perms; イベント (unpublished, order 10) and
    // 管理 (needs identity:admin, order 50) both grey and sink below メール (order 45).
    const me: gateway.MeResponse = { ...ME, permissions: ["identity:read", "mail:read"] };
    const memberApi = { auth: { me: () => Promise.resolve(me) } } as unknown as ApiClient;
    const nav: NavEntry[] = [
      { label: "イベント", path: "/events", icon: "calendar", order: 10, appId: "events" },
      { label: "メール", path: "/mail", icon: "inbox", order: 45, appId: "mail" },
      { label: "管理", path: "/admin/roles", icon: "shield", order: 50, appId: "mail", requiredPermissions: ["identity:admin"] },
    ];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider api={memberApi}>
          <AppShellLayout navEntries={nav} onNavigate={vi.fn()}>
            <div data-testid="outlet">content</div>
          </AppShellLayout>
        </AuthProvider>
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByTestId("fe2-app-launcher-trigger"));
    const tiles = screen.getAllByRole("menuitem").map((el) => el.getAttribute("data-testid"));
    // メール (usable) first; then the two greyed apps in their original order (events<admin).
    expect(tiles).toEqual([
      "fe2-app-launcher-item-mail",
      "fe2-app-launcher-item-events",
      "fe2-app-launcher-item-admin-roles",
    ]);
    // The two trailing tiles are the greyed ones.
    expect(screen.getByTestId("fe2-app-launcher-item-mail")).toBeEnabled();
    expect(screen.getByTestId("fe2-app-launcher-item-events")).toBeDisabled();
    expect(screen.getByTestId("fe2-app-launcher-item-admin-roles")).toBeDisabled();
  });
});
