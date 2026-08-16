import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

  it("shows the signed-in user's email as the shell header title once /me resolves", async () => {
    renderShell();
    // Header title starts on the brand fallback while /me is pending, then swaps
    // to the resolved email (never a blank title in between).
    const header = screen.getByTestId("fe2-shell-header");
    expect(header).toHaveTextContent("DevHub");
    expect(await screen.findByText("kota@developershub.jp")).toBeInTheDocument();
    expect(screen.queryByText("DevHub")).not.toBeInTheDocument();
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

  it("renders injected nav badge from badgeSource inside the launcher", async () => {
    renderShell();
    await userEvent.click(screen.getByTestId("fe2-app-launcher-trigger"));
    // badgeSource() -> AppLauncherItem.badgeCount -> @dub/ui Badge on the tile.
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("calls onNavigate on launcher tile click and onLogout on logout", async () => {
    const onNavigate = vi.fn();
    const onLogout = vi.fn();
    renderShell(onNavigate, onLogout);
    await userEvent.click(screen.getByTestId("fe2-app-launcher-trigger"));
    await userEvent.click(screen.getByText("Events"));
    expect(onNavigate).toHaveBeenCalledWith("/events");
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
  // members, while admins/maintainers bypass the gate and see every app active.
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

  it("admins/maintainers bypass the gate: every app is active", async () => {
    // holds identity:admin (a dangerous permission) -> privileged -> no greying.
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
    // Privileged (holds mail:admin, a dangerous perm → bypasses the release gate) but
    // does NOT hold identity:admin, so ロール管理 must grey — same as its route 403ing.
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
