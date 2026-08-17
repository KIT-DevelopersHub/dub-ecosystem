// HomeScreen (design 2-1): FE2 owns the dashboard frame. Verifies the two
// BFF-data-driven cards (upcoming events, unread notifications), per-frame
// partial-error surfacing (no global toast), and that feature-contributed
// homeWidgets render inside isolated error boundaries — one throwing widget
// never blanks the dashboard. All run against a faked ApiClient (no network).
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { gateway } from "@dub/types";
import type { ApiClient } from "../../lib/api-client.tsx";
import type { HomeWidget } from "../../modules/types.tsx";
import { AuthProvider } from "../../auth/AuthProvider.tsx";
import { HomeScreen } from "./HomeScreen.tsx";

function makeApi(home: gateway.BffHomeResponse): ApiClient {
  return { bff: { home: () => Promise.resolve(home) } } as unknown as ApiClient;
}

// Auth stub: an admin session (identity:admin) so the dashboard launchpad renders every
// app tile active — the release gate (lib/releaseGate) greys tiles for non-admins, so an
// admin context keeps these BFF-focused tests exercising the full, ungated dashboard.
const AUTH_API = {
  auth: {
    me: () =>
      Promise.resolve({
        user: { id: "usr_admin", email: "admin@dub.jp", displayName: "Admin" },
        orgId: "org_1",
        permissions: ["identity:admin"],
        sessionExpiresAt: Date.now() + 60 * 60 * 1000,
      }),
  },
} as unknown as ApiClient;

function wrap(ui: ReactNode): JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <AuthProvider api={AUTH_API}>{ui}</AuthProvider>
    </QueryClientProvider>
  );
}

const OK_HOME: gateway.BffHomeResponse = {
  upcomingEvents: [
    { id: "evt_1", title: "Conf", phase: "planning", startsAt: null },
    { id: "evt_2", title: "Meetup", phase: "preparing", startsAt: null },
  ],
  unreadCount: 4,
  partialErrors: [],
};

describe("HomeScreen", () => {
  it("renders the events and unread-notifications cards from /bff/home", async () => {
    render(wrap(<HomeScreen api={makeApi(OK_HOME)} />));
    await waitFor(() => expect(screen.getByText("Conf")).toBeInTheDocument());
    expect(screen.getByText("Meetup")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-home-unread-count")).toHaveTextContent("未読 4 件");
  });

  it("shows the empty state when there are no unread notifications", async () => {
    render(wrap(<HomeScreen api={makeApi({ ...OK_HOME, unreadCount: 0 })} />));
    await waitFor(() => expect(screen.getByTestId("fe2-home-unread-empty")).toBeInTheDocument());
    expect(screen.queryByTestId("fe2-home-unread-count")).not.toBeInTheDocument();
  });

  it("surfaces per-frame partial errors without dropping the other card", async () => {
    const home: gateway.BffHomeResponse = {
      ...OK_HOME,
      partialErrors: [{ source: "notification-service", code: "UPSTREAM_TIMEOUT" }],
    };
    render(wrap(<HomeScreen api={makeApi(home)} />));
    // Notifications frame shows its error; events frame still renders its list.
    await waitFor(() => expect(screen.getByTestId("fe2-home-notifications-error")).toBeInTheDocument());
    expect(screen.getByText("Conf")).toBeInTheDocument();
    expect(screen.queryByTestId("fe2-home-unread-count")).not.toBeInTheDocument();
  });

  it("keeps the notification dialog reachable from Home even on a partial error", async () => {
    // Regression: a /bff/home partial error on the notification aggregate must
    // NOT remove the Home entry point to the shared dialog. When onOpenNotifications
    // is wired (the real shell always wires it), the card stays an openable button
    // that fires the handler — the dialog itself re-fetches the inbox as the retry.
    const home: gateway.BffHomeResponse = {
      ...OK_HOME,
      partialErrors: [{ source: "notification-service", code: "UPSTREAM_TIMEOUT" }],
    };
    const opened: number[] = [];
    render(wrap(<HomeScreen api={makeApi(home)} onOpenNotifications={() => opened.push(1)} />));
    const btn = await screen.findByTestId("fe2-home-open-notifications");
    // The inline retry card (no dialog entry point) must NOT be used here.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    btn.click();
    expect(opened).toHaveLength(1);
  });

  it("renders feature-contributed home widgets in titled frames", async () => {
    const widgets: HomeWidget[] = [
      { id: "tasks", title: "自分のタスク", Body: () => <p data-testid="tasks-body">3 件</p> },
    ];
    render(wrap(<HomeScreen api={makeApi(OK_HOME)} homeWidgets={widgets} />));
    await waitFor(() => expect(screen.getByTestId("tasks-body")).toBeInTheDocument());
    expect(screen.getByText("自分のタスク")).toBeInTheDocument();
  });

  it("isolates a throwing widget so the rest of the dashboard survives", async () => {
    const Boom = (): JSX.Element => {
      throw new Error("widget exploded");
    };
    const widgets: HomeWidget[] = [{ id: "chat", title: "チャット", Body: Boom }];
    render(wrap(<HomeScreen api={makeApi(OK_HOME)} homeWidgets={widgets} />));
    // The crashing widget is boxed into its own in-frame fallback...
    expect(await screen.findByTestId("home-widget-chat-error")).toBeInTheDocument();
    // ...while the dashboard-owned cards still resolve and render normally.
    expect(await screen.findByText("Conf")).toBeInTheDocument();
    expect(await screen.findByTestId("fe2-home-unread-count")).toBeInTheDocument();
  });

  // ── Dashboard launchpad member release gate (second surface, mirrors AppLauncher) ──
  function wrapAs(ui: ReactNode, permissions: string[]): JSX.Element {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const api = {
      auth: {
        me: () =>
          Promise.resolve({
            user: { id: "u", email: "u@dub.jp", displayName: "U" },
            orgId: "org_1",
            permissions,
            sessionExpiresAt: Date.now() + 3_600_000,
          }),
      },
    } as unknown as ApiClient;
    return (
      <QueryClientProvider client={client}>
        <AuthProvider api={api}>{ui}</AuthProvider>
      </QueryClientProvider>
    );
  }

  it("greys + disables non-published app tiles for a non-admin (only メール clickable)", async () => {
    // A maintainer holds dangerous perms but NOT identity:admin — the exact account
    // class that used to bypass the gate and see every app active (the reported bug).
    const maintainer = ["identity:read", "event:admin", "mail:send", "chat:moderate", "infra:deploy"];
    render(wrapAs(<HomeScreen api={makeApi(OK_HOME)} />, maintainer));
    // Published app (mail) stays an active link.
    const mail = await screen.findByTestId("fe2-home-tile-mail");
    expect(mail.tagName).toBe("A");
    expect(mail).not.toHaveAttribute("aria-disabled");
    // Every other app is greyed + non-interactive (span, aria-disabled, no href).
    for (const id of ["events", "tasks", "gantt", "notifications", "chat", "usage", "members", "driveshare"]) {
      const tile = screen.getByTestId(`fe2-home-tile-${id}`);
      expect(tile.tagName).toBe("SPAN");
      expect(tile).toHaveAttribute("aria-disabled", "true");
      expect(tile).not.toHaveAttribute("href");
    }
  });

  it("keeps every dashboard app tile active for an admin (identity:admin)", async () => {
    render(wrapAs(<HomeScreen api={makeApi(OK_HOME)} />, ["identity:admin"]));
    // Wait for /me to resolve (tiles render gated during the loading fail-closed window).
    await waitFor(() => expect(screen.getByTestId("fe2-home-tile-events").tagName).toBe("A"));
    for (const id of ["events", "mail", "chat", "driveshare"]) {
      const tile = screen.getByTestId(`fe2-home-tile-${id}`);
      expect(tile.tagName).toBe("A");
      expect(tile).not.toHaveAttribute("aria-disabled");
    }
  });
});
