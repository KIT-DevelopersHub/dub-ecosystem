import { useState } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import { policy, type gateway } from "@dub/types";
import type { ApiClient } from "../lib/api-client.tsx";
import { AuthProvider } from "../auth/AuthProvider.tsx";
import { AppShellLayout, buildPaletteCommands, truncateEmail } from "./AppShellLayout.tsx";
import { useUiStore } from "../store/uiStore.tsx";
import type { NavEntry } from "../modules/types.tsx";

const ME: gateway.MeResponse = {
  user: { id: "usr_1", displayName: "Kota", avatarUrl: null, email: "kota@developershub.jp" },
  orgId: "org_devhub",
  permissions: [],
  sessionExpiresAt: Date.now() + 60_000,
};

const EMPTY_PARTICIPATION = {
  lastName: null, firstName: null, lastNameKana: null, firstNameKana: null,
  lastNameRomaji: null, firstNameRomaji: null, schoolEmail: null, gmail: null,
  phone: null, grade: null, department: null, desiredActivity: null, note: null,
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

  it("surfaces theme via a single カラー設定 menu item that opens a dialog (not bare rows)", async () => {
    renderShell(vi.fn());
    // No standalone header theme control, and the three theme rows no longer sit directly
    // in the ⚙ menu — they moved behind one カラー設定 entry → dialog.
    expect(screen.queryByTestId("fe2-theme-toggle-trigger")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe2-theme-option-dark")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe2-color-settings-open")).not.toBeInTheDocument();
    // Open 設定 → カラー設定 is present (a single row), the raw theme options are not.
    await userEvent.click(await screen.findByTestId("fe2-settings-menu-trigger"));
    const colorItem = screen.getByTestId("fe2-color-settings-open");
    expect(colorItem).toHaveTextContent("カラー設定");
    expect(screen.queryByTestId("fe2-theme-option-dark")).not.toBeInTheDocument();
    // Clicking it opens the カラー設定 dialog with the theme segmented control inside.
    await userEvent.click(colorItem);
    expect(await screen.findByTestId("fe2-color-settings")).toBeInTheDocument();
    // Selecting a theme in the dialog drives UiStore.setTheme (全アプリ波及 + localStorage永続の入口).
    await userEvent.click(screen.getByTestId("fe2-theme-option-dark"));
    expect(useUiStore.getState().theme).toBe("dark");
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
      auth: { me: () => Promise.resolve(ME), changePassword, updateProfile: vi.fn(() => Promise.resolve({ displayName: ME.user.displayName, avatarUrl: null })), getSelfParticipation: vi.fn(() => Promise.resolve(EMPTY_PARTICIPATION)), updateSelfParticipation: vi.fn((p) => Promise.resolve(p)) },
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
      auth: { me: () => Promise.resolve(ME), changePassword: vi.fn(() => Promise.resolve()), updateProfile: vi.fn(() => Promise.resolve({ displayName: ME.user.displayName, avatarUrl: null })), getSelfParticipation: vi.fn(() => Promise.resolve(EMPTY_PARTICIPATION)), updateSelfParticipation: vi.fn((p) => Promise.resolve(p)) },
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
    // Order: アカウント設定, カラー設定 (opens the dialog), 問い合わせ, then logout last.
    // Logout is danger-toned and ordered AFTER the self-service rows.
    const items = screen.getAllByRole("menuitem").map((el) => el.getAttribute("data-testid"));
    expect(items).toEqual([
      "fe2-account-settings-open",
      "fe2-color-settings-open",
      "fe2-inquiry-open",
      "fe2-logout",
    ]);
    const logout = screen.getByTestId("fe2-logout");
    expect(logout).toHaveAttribute("data-tone", "danger");
    // One separator: above the 離脱 (logout) action, set apart from the safe settings above.
    expect(screen.getAllByRole("separator")).toHaveLength(1);
    await userEvent.click(logout);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("メール設定 sits in the 設定 menu for mail users and opens Gmail への自動転送", async () => {
    const mailMe: gateway.MeResponse = { ...ME, permissions: ["mail:read"], appAccess: { mail: policy.AppAccessLevel.View } } as gateway.MeResponse;
    const request = vi.fn(() => Promise.resolve({ target: null, status: "none", enabled: false, active: false, available: true, requestedAt: null, verifiedAt: null, lastResult: null, lastError: null, lastAt: null }));
    const shellApi = { auth: { me: () => Promise.resolve(mailMe) }, request } as unknown as ApiClient;
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
    await userEvent.click(await screen.findByTestId("fe2-settings-menu-trigger"));
    const items = screen.getAllByRole("menuitem").map((el) => el.getAttribute("data-testid"));
    expect(items).toEqual(["fe2-account-settings-open", "fe2-mail-settings-open", "fe2-color-settings-open", "fe2-inquiry-open", "fe2-logout"]);
    await userEvent.click(screen.getByTestId("fe2-mail-settings-open"));
    expect(await screen.findByTestId("fe2-mail-forward-dialog")).toBeInTheDocument();
    expect(screen.getByText("Gmail への自動転送")).toBeInTheDocument();
    expect(await screen.findByTestId("fe2-mail-forward-input")).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: "GET", path: "/api/v1/mail/forward" }));
  });

  it("問い合わせ lives in the 設定 menu (no floating corner button) and opens the inquiry dialog", async () => {
    const shellApi = { auth: { me: () => Promise.resolve(ME) }, request: vi.fn() } as unknown as ApiClient;
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
    await userEvent.click(await screen.findByTestId("fe2-settings-menu-trigger"));
    // The old always-visible bottom-right button is gone.
    expect(screen.queryByTestId("fe2-feedback-fab")).toBeNull();
    const item = screen.getByTestId("fe2-inquiry-open");
    expect(item).toHaveTextContent("問い合わせ");
    await userEvent.click(item);
    expect(await screen.findByTestId("fe2-inquiry-dialog")).toBeInTheDocument();
  });

  it("hides メール設定 from viewers without mail access", async () => {
    renderShell(vi.fn(), vi.fn());
    const trigger = await screen.findByTestId("fe2-settings-menu-trigger");
    await userEvent.click(trigger);
    expect(screen.queryByTestId("fe2-mail-settings-open")).toBeNull();
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

  // Member release-gating (lib/releaseGate). An app the viewer cannot open is HIDDEN
  // from the launcher; ONLY full admins (identity:admin) bypass the release gate —
  // non-admin operator roles are gated like members (#255, 2026-08-17).
  const GATED_NAV: NavEntry[] = [
    { label: "メール", path: "/mail", icon: "inbox", order: 45, appId: "mail" },
    { label: "イベント", path: "/events", icon: "calendar", order: 10, appId: "events" },
  ];

  it("hides unpublished apps from a general member", async () => {
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
    // メール is member-published -> shown; イベント is not -> not rendered at all.
    expect(screen.getByTestId("fe2-app-launcher-item-mail")).toBeEnabled();
    expect(screen.queryByTestId("fe2-app-launcher-item-events")).not.toBeInTheDocument();
  });

  it("ENABLES an unpublished app for a non-admin once ロール管理 grants app:<id>:view (#270 fix)", async () => {
    // organizer-like: not admin, holds event:read AND the per-app grant app:events:view.
    // Before the fix the release gate gated events (not member-published) despite the
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

  it("hides the app again when the per-app grant is revoked (OFF)", async () => {
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
    expect(screen.queryByTestId("fe2-app-launcher-item-events")).not.toBeInTheDocument();
  });

  it("navigates when a member clicks a shown tile", async () => {
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
    await userEvent.click(screen.getByTestId("fe2-app-launcher-item-mail"));
    expect(onNavigate).toHaveBeenCalledWith("/mail");
  });

  it("a full admin (identity:admin) bypasses the gate: every app is active", async () => {
    // holds identity:admin -> privileged -> nothing hidden (#255 admin-only bypass).
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

  // Permission gate: an app whose requiredPermissions the viewer lacks is hidden for
  // EVERYONE (privileged included), matching the route's requiredPermissions guard
  // (router.tsx RequirePermission → 403). All GATED apps are published here so the
  // release gate is out of the way and the permission gate is what's under test.
  const PERM_NAV: NavEntry[] = [
    { label: "ロール管理", path: "/admin/roles", icon: "shield", order: 50, appId: "mail", requiredPermissions: ["identity:admin"] },
    { label: "メール", path: "/mail", icon: "inbox", order: 45, appId: "mail" },
  ];

  it("hides an app whose requiredPermissions a privileged viewer still lacks", async () => {
    // Holds mail:admin (both apps use the published appId "mail", so the release gate is
    // out of the way) but NOT identity:admin, so the identity:admin-gated ロール管理 must
    // be hidden via the permission gate — same as its route 403ing.
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
    expect(screen.queryByTestId("fe2-app-launcher-item-admin-roles")).not.toBeInTheDocument();
    expect(screen.getByTestId("fe2-app-launcher-item-mail")).toBeEnabled();
  });

  it("lists only the apps the viewer can open, in order", async () => {
    // member: only メール is published + within perms; イベント (unpublished, order 10) and
    // 管理 (needs identity:admin, order 50) are both hidden.
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
    // AppLauncher tiles are listbox options (search/keyboard-nav a11y model).
    const tiles = screen.getAllByRole("option").map((el) => el.getAttribute("data-testid"));
    expect(tiles).toEqual(["fe2-app-launcher-item-mail"]);
  });
});

describe("AppShellLayout launcher badge hooks", () => {
  it("keeps badge hook calls stable when a gated app appears after /me resolves", async () => {
    // badgeSource is a hook; filtering before calling it would change the hook count once
    // permissions load (React #310). The gated tile must simply appear, with its badge.
    const useBadge = (): number => useState(3)[0];
    const me: gateway.MeResponse = { ...ME, permissions: ["identity:read", "mail:read"] };
    const api = { auth: { me: () => Promise.resolve(me) } } as unknown as ApiClient;
    const nav: NavEntry[] = [
      { label: "メール", path: "/mail", icon: "inbox", order: 45, appId: "mail", requiredPermissions: ["mail:read"], badgeSource: useBadge },
      { label: "管理", path: "/admin/roles", icon: "shield", order: 50, appId: "mail", requiredPermissions: ["identity:admin"], badgeSource: useBadge },
    ];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider api={api}>
          <AppShellLayout navEntries={nav} onNavigate={vi.fn()}>
            <div data-testid="outlet">content</div>
          </AppShellLayout>
        </AuthProvider>
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByTestId("fe2-app-launcher-trigger"));
    expect(await screen.findByTestId("fe2-app-launcher-item-mail")).toBeEnabled();
    expect(screen.queryByTestId("fe2-app-launcher-item-admin-roles")).not.toBeInTheDocument();
  });
});

describe("buildPaletteCommands", () => {
  it("lists only the apps the viewer can open, matching the launcher", () => {
    const granted = new Set(["identity:read", "mail:read"]);
    const can = (p: string) => granted.has(p);
    const nav: NavEntry[] = [
      { label: "イベント", path: "/events", icon: "calendar", order: 10, appId: "events" },
      { label: "メール", path: "/mail", icon: "inbox", order: 45, appId: "mail" },
      { label: "管理", path: "/admin/roles", icon: "shield", order: 50, appId: "mail", requiredPermissions: ["identity:admin"] },
    ];
    const apps = buildPaletteCommands(nav, can, {}).filter((c) => c.group === "アプリ");
    expect(apps.map((c) => c.id)).toEqual(["app:/mail"]);
  });
});
