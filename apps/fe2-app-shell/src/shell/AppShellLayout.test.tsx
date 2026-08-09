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
  { label: "Chat", path: "/chat", icon: "message-square", order: 20, badgeSource: () => 5 },
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

  it("renders nav entries, header widget slot and routed content", () => {
    renderShell();
    expect(screen.getByText("Events")).toBeInTheDocument();
    expect(screen.getByText("Chat")).toBeInTheDocument();
    expect(screen.getByTestId("header-widget")).toBeInTheDocument();
    expect(screen.getByTestId("outlet")).toBeInTheDocument();
  });

  it("renders injected nav badge from badgeSource", () => {
    renderShell();
    expect(screen.getByLabelText("5 件の未読")).toBeInTheDocument();
  });

  it("calls onNavigate on nav click and onLogout on logout", async () => {
    const onNavigate = vi.fn();
    const onLogout = vi.fn();
    renderShell(onNavigate, onLogout);
    await userEvent.click(screen.getByText("Events"));
    expect(onNavigate).toHaveBeenCalledWith("/events");
    await userEvent.click(screen.getByTestId("fe2-logout"));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("toggles the sidebar via the store", async () => {
    renderShell();
    expect(useUiStore.getState().sidebarOpen).toBe(true);
    await userEvent.click(screen.getByTestId("fe2-sidebar-toggle"));
    expect(useUiStore.getState().sidebarOpen).toBe(false);
  });
});
