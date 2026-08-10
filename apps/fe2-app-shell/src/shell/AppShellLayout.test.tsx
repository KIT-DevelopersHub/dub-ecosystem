import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { gateway } from "@dub/types";
import type { ApiClient } from "../lib/api-client.tsx";
import { AuthProvider } from "../auth/AuthProvider.tsx";
import { AppShellLayout } from "./AppShellLayout.tsx";
import { useUiStore } from "../store/uiStore.tsx";
import type { NavEntry } from "../modules/types.tsx";

const ME: gateway.MeResponse = {
  user: { id: "usr_1", displayName: "Kota", avatarUrl: null },
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

  it("hides launcher items whose requiredPermissions the viewer lacks (admin-only tools)", async () => {
    const me: gateway.MeResponse = { ...ME, permissions: ["event:read"] };
    const gatedApi = { auth: { me: () => Promise.resolve(me) } } as unknown as ApiClient;
    const nav: NavEntry[] = [
      { label: "Events", path: "/events", icon: "calendar", order: 10 },
      { label: "ロール管理", path: "/admin/roles", icon: "shield", order: 50, requiredPermissions: ["identity:read"] },
    ];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider api={gatedApi}>
          <AppShellLayout navEntries={nav} onNavigate={vi.fn()}>
            <div data-testid="outlet">content</div>
          </AppShellLayout>
        </AuthProvider>
      </QueryClientProvider>,
    );
    // /me resolves async; wait for the launcher trigger then open it.
    const trigger = await screen.findByTestId("fe2-app-launcher-trigger");
    await userEvent.click(trigger);
    expect(screen.getByText("Events")).toBeInTheDocument();
    // Viewer lacks identity:read -> the admin tool is filtered out.
    expect(screen.queryByText("ロール管理")).not.toBeInTheDocument();
  });

  it("shows admin launcher items once the viewer holds the required permission", async () => {
    const me: gateway.MeResponse = { ...ME, permissions: ["event:read", "identity:read"] };
    const adminApi = { auth: { me: () => Promise.resolve(me) } } as unknown as ApiClient;
    const nav: NavEntry[] = [
      { label: "ロール管理", path: "/admin/roles", icon: "shield", order: 50, requiredPermissions: ["identity:read"] },
    ];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider api={adminApi}>
          <AppShellLayout navEntries={nav} onNavigate={vi.fn()}>
            <div data-testid="outlet">content</div>
          </AppShellLayout>
        </AuthProvider>
      </QueryClientProvider>,
    );
    const trigger = await screen.findByTestId("fe2-app-launcher-trigger");
    await userEvent.click(trigger);
    expect(await screen.findByText("ロール管理")).toBeInTheDocument();
  });
});
