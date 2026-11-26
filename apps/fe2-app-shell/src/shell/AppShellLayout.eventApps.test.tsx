// 使うアプリ: the launcher greys (never removes) tiles of apps the CURRENT event does not
// use, and changes nothing while the setting is unknown (legacy events = every app on).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@dub/ui";
import type { event, gateway } from "@dub/types";
import { useCurrentEventStore } from "@dub/fe3-event-action";
import type { ApiClient } from "../lib/api-client.tsx";
import { AuthProvider } from "../auth/AuthProvider.tsx";
import { AppShellLayout, toLauncherItems } from "./AppShellLayout.tsx";
import { EVENT_DISABLED_REASON } from "../lib/eventApps.ts";
import type { NavEntry } from "../modules/types.tsx";

const ME: gateway.MeResponse = {
  user: { id: "usr_1", displayName: "Kota", avatarUrl: null, email: "kota@developershub.jp" },
  orgId: "org_devhub",
  permissions: ["identity:admin", "event:read", "app:events:view"],
  sessionExpiresAt: Date.now() + 60_000,
};

const NAV: NavEntry[] = [
  { label: "イベント", path: "/events", icon: "calendar", order: 10, appId: "events" },
  { label: "ガントチャート", path: "/gantt", icon: "calendar", order: 20, appId: "gantt" },
  { label: "運営メンバー", path: "/members", icon: "users", order: 30, appId: "members" },
];

function apiReturning(apps: event.EventAppsResponse | null): ApiClient & { request: ReturnType<typeof vi.fn> } {
  const request = vi.fn(async (input: { path: string }) => {
    if (apps && input.path === `/api/v1/events/${apps.eventId}/apps`) return apps;
    throw new Error(`unexpected ${input.path}`);
  });
  return { auth: { me: () => Promise.resolve(ME) }, request } as unknown as ApiClient & { request: typeof request };
}

function renderShell(api: ApiClient) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AuthProvider api={api}>
          <AppShellLayout navEntries={NAV} onNavigate={vi.fn()} api={api}>
            <div data-testid="outlet">content</div>
          </AppShellLayout>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => useCurrentEventStore.getState().setEventId(null));

describe("launcher x 使うアプリ", () => {
  it("greys apps the current event does not use, keeping every tile", async () => {
    useCurrentEventStore.getState().setEventId("evt_new");
    renderShell(apiReturning({ eventId: "evt_new", enabledApps: ["events", "gantt", "admin"], customized: true, updatedAt: null }));
    await userEvent.click(await screen.findByTestId("fe2-app-launcher-trigger"));
    const members = await screen.findByTestId("fe2-app-launcher-item-members");
    await vi.waitFor(() => expect(members).toBeDisabled());
    expect(members.getAttribute("title")).toBe(EVENT_DISABLED_REASON);
    expect(screen.getByTestId("fe2-app-launcher-item-gantt")).toBeEnabled();
    expect(screen.getByTestId("fe2-app-launcher-item-events")).toBeEnabled();
  });

  it("with no event selected nothing is greyed and no request is made", async () => {
    const api = apiReturning(null);
    renderShell(api);
    await userEvent.click(await screen.findByTestId("fe2-app-launcher-trigger"));
    expect(await screen.findByTestId("fe2-app-launcher-item-members")).toBeEnabled();
    expect(api.request.mock.calls.filter(([i]) => String((i as { path: string }).path).endsWith("/apps"))).toEqual([]);
  });

  it("toLauncherItems: null (unknown / legacy) changes nothing", () => {
    const can = () => true;
    expect(toLauncherItems(NAV, can, null).every((i) => !i.disabled)).toBe(true);
    const greyed = toLauncherItems(NAV, can, new Set(["events"]));
    expect(greyed.map((i) => [i.id, Boolean(i.disabled)])).toEqual([
      ["/events", false],
      ["/gantt", true],
      ["/members", true],
    ]);
  });
});
