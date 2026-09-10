// HomeScreen (design 2-1): FE2 owns the dashboard frame. Verifies the two
// BFF-data-driven cards (upcoming events, unread notifications), per-frame
// partial-error surfacing (no global toast), and that feature-contributed
// homeWidgets render inside isolated error boundaries — one throwing widget
// never blanks the dashboard. All run against a faked ApiClient (no network).
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import type { gateway } from "@dub/types";
import type { ApiClient } from "../../lib/api-client.tsx";
import type { HomeWidget } from "../../modules/types.tsx";
import { useUiStore } from "../../store/uiStore.tsx";
import { HomeScreen } from "./HomeScreen.tsx";

function makeApi(home: gateway.BffHomeResponse): ApiClient {
  return { bff: { home: () => Promise.resolve(home) } } as unknown as ApiClient;
}

function wrap(ui: ReactNode): JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

const OK_HOME: gateway.BffHomeResponse = {
  upcomingEvents: [
    { id: "evt_1", title: "Conf", phase: "planning", startsAt: null },
    { id: "evt_2", title: "Meetup", phase: "preparing", startsAt: null },
  ],
  unreadCount: 4,
  taskSummary: {
    total: 20,
    byStatus: { todo: 4, in_progress: 3, blocked: 1, done: 12, cancelled: 0 },
  },
  usageSummary: {
    metrics: [
      { key: "kv_reads_day", label: "KV 読み取り(日)", pct: 82.0 },
      { key: "emails_month", label: "メール送信(月)", pct: 20.0 },
    ],
    worst: { key: "kv_reads_day", label: "KV 読み取り(日)", pct: 82.0 },
  },
  orgStats: { members: 12, teams: 4 },
  partialErrors: [],
};

describe("HomeScreen", () => {
  it("renders the events and unread-notifications cards from /bff/home", async () => {
    render(wrap(<HomeScreen api={makeApi(OK_HOME)} />));
    await waitFor(() => expect(screen.getByText("Conf")).toBeInTheDocument());
    expect(screen.getByText("Meetup")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-home-unread-count")).toHaveTextContent("未読 4 件");
  });

  it("renders the live task / free-tier / member aggregates from /bff/home", async () => {
    render(wrap(<HomeScreen api={makeApi(OK_HOME)} />));
    // タスク完了率 = done 12 / total 20 = 60%.
    await waitFor(() => expect(screen.getByTestId("fe2-kpi-tasks-value")).toHaveTextContent("60%"));
    // 無料枠 最逼迫 = worst metric pct.
    expect(screen.getByTestId("fe2-kpi-freetier-value")).toHaveTextContent("82%");
    // 運営メンバー count.
    expect(screen.getByTestId("fe2-kpi-members-value")).toHaveTextContent("12");
    // No "デモ" tag remains on the now-live tiles.
    expect(screen.queryByTestId("fe2-kpi-tasks-demo")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe2-kpi-freetier-demo")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe2-kpi-members-demo")).not.toBeInTheDocument();
    // The visualization cards render from live data.
    expect(screen.getByTestId("fe2-usage-kv_reads_day")).toBeInTheDocument();
    expect(screen.getByTestId("fe2-home-task-segbar")).toBeInTheDocument();
  });

  it("surfaces the free-tier partial error in-frame without dropping the task card", async () => {
    const home: gateway.BffHomeResponse = {
      ...OK_HOME,
      partialErrors: [{ source: "usage-meter", code: "UPSTREAM_TIMEOUT" }],
    };
    render(wrap(<HomeScreen api={makeApi(home)} />));
    await waitFor(() => expect(screen.getByTestId("fe2-home-usage-error")).toBeInTheDocument());
    // The 無料枠 KPI degrades to a dash; the task card still renders its breakdown.
    expect(screen.getByTestId("fe2-kpi-freetier-value")).toHaveTextContent("—");
    expect(screen.getByTestId("fe2-home-task-segbar")).toBeInTheDocument();
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

  // ── P3-3: inline 編集モード (reorder / hide / density on the live dashboard) ──────
  describe("編集モード (P3-3)", () => {
    beforeEach(() => {
      localStorage.clear();
      useUiStore.setState({ homeDensity: "comfortable", homeLayout: { order: [], hidden: [] } });
    });

    it("reflects the persisted density on the dashboard root", async () => {
      useUiStore.setState({ homeDensity: "compact", homeLayout: { order: [], hidden: [] } });
      render(wrap(<HomeScreen api={makeApi(OK_HOME)} />));
      await waitFor(() => expect(screen.getByTestId("fe2-kpi-members-value")).toHaveTextContent("12"));
      expect(screen.getByTestId("fe2-home")).toHaveAttribute("data-density", "compact");
    });

    it("hides a widget the viewer has hidden and keeps the rest", async () => {
      useUiStore.setState({ homeLayout: { order: [], hidden: ["kpi-members", "card-usage"] } });
      render(wrap(<HomeScreen api={makeApi(OK_HOME)} />));
      await waitFor(() => expect(screen.getByTestId("fe2-kpi-countdown")).toBeInTheDocument());
      expect(screen.queryByTestId("fe2-kpi-members")).not.toBeInTheDocument();
      expect(screen.queryByTestId("fe2-home-usage")).not.toBeInTheDocument();
      // Untouched widgets still render.
      expect(screen.getByTestId("fe2-kpi-tasks")).toBeInTheDocument();
      expect(screen.getByTestId("fe2-home-tasks")).toBeInTheDocument();
    });

    it("renders KPI tiles in the viewer's saved order", async () => {
      useUiStore.setState({ homeLayout: { order: ["kpi-members", "kpi-countdown"], hidden: [] } });
      render(wrap(<HomeScreen api={makeApi(OK_HOME)} />));
      await waitFor(() => expect(screen.getByTestId("fe2-kpi-members")).toBeInTheDocument());
      const ids = Array.from(screen.getByTestId("fe2-home-kpis").children).map((el) => el.getAttribute("data-testid"));
      // The two reordered tiles come first, in the saved order.
      expect(ids.indexOf("fe2-kpi-members")).toBeLessThan(ids.indexOf("fe2-kpi-countdown"));
      expect(ids[0]).toBe("fe2-kpi-members");
    });

    it("the 編集 button starts idle: no drag handles / hide toggles on the resting dashboard", async () => {
      render(wrap(<HomeScreen api={makeApi(OK_HOME)} />));
      await waitFor(() => expect(screen.getByTestId("fe2-kpi-members")).toBeInTheDocument());
      expect(screen.getByTestId("fe2-home-edit-toggle")).toHaveTextContent("編集");
      expect(screen.queryByTestId("fe2-widget-handle-kpi-members")).not.toBeInTheDocument();
      expect(screen.getByTestId("fe2-home")).toHaveAttribute("data-editing", "false");
    });

    it("編集 reveals a drag handle + hide toggle per widget, and 完了 exits cleanly", async () => {
      render(wrap(<HomeScreen api={makeApi(OK_HOME)} />));
      await waitFor(() => expect(screen.getByTestId("fe2-kpi-members")).toBeInTheDocument());

      fireEvent.click(screen.getByTestId("fe2-home-edit-toggle"));
      expect(screen.getByTestId("fe2-home")).toHaveAttribute("data-editing", "true");
      expect(screen.getByTestId("fe2-home-edit-toggle")).toHaveTextContent("完了");
      // The handle is keyboard-operable (dnd-kit sortable a11y attributes) —
      // pointer AND keyboard reorder both go through this same element.
      const handle = screen.getByTestId("fe2-widget-handle-kpi-members");
      expect(handle).toHaveAttribute("aria-roledescription", "sortable");
      expect(handle).toHaveAttribute("tabindex", "0");
      expect(screen.getByTestId("fe2-widget-hide-kpi-members")).toBeInTheDocument();
      // Density toggle + reset are only surfaced while editing.
      expect(screen.getByTestId("fe2-home-density-compact")).toBeInTheDocument();
      expect(screen.getByTestId("fe2-home-edit-reset")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("fe2-home-edit-toggle"));
      expect(screen.getByTestId("fe2-home")).toHaveAttribute("data-editing", "false");
      expect(screen.queryByTestId("fe2-widget-handle-kpi-members")).not.toBeInTheDocument();
      expect(screen.queryByTestId("fe2-home-density-compact")).not.toBeInTheDocument();
      // The widget itself is unaffected by the round trip.
      expect(screen.getByTestId("fe2-kpi-members")).toBeInTheDocument();
    });

    it("toggling a widget's hide button in 編集モード hides it on the dashboard and persists", async () => {
      render(wrap(<HomeScreen api={makeApi(OK_HOME)} />));
      await waitFor(() => expect(screen.getByTestId("fe2-kpi-members")).toBeInTheDocument());
      fireEvent.click(screen.getByTestId("fe2-home-edit-toggle"));
      fireEvent.click(screen.getByTestId("fe2-widget-hide-kpi-members"));
      // Still present but dimmed/inert while editing (reversible without leaving edit mode)...
      expect(screen.getByTestId("fe2-widget-edit-kpi-members")).toHaveAttribute("data-hidden", "true");
      // ...and persisted for the resting dashboard / next load.
      expect(useUiStore.getState().homeLayout.hidden).toContain("kpi-members");
      expect(JSON.parse(localStorage.getItem("dub.ui.home.layout")!).hidden).toContain("kpi-members");
      fireEvent.click(screen.getByTestId("fe2-home-edit-toggle"));
      expect(screen.queryByTestId("fe2-kpi-members")).not.toBeInTheDocument();
    });

    it("switching density from the 編集 toolbar persists immediately", async () => {
      render(wrap(<HomeScreen api={makeApi(OK_HOME)} />));
      await waitFor(() => expect(screen.getByTestId("fe2-kpi-members")).toBeInTheDocument());
      fireEvent.click(screen.getByTestId("fe2-home-edit-toggle"));
      fireEvent.click(screen.getByTestId("fe2-home-density-compact"));
      expect(screen.getByTestId("fe2-home")).toHaveAttribute("data-density", "compact");
      expect(localStorage.getItem("dub.ui.home.density")).toBe("compact");
    });

    it("既定に戻す resets order/hidden/density from inside 編集モード", async () => {
      useUiStore.setState({ homeDensity: "compact", homeLayout: { order: [], hidden: ["kpi-members"] } });
      render(wrap(<HomeScreen api={makeApi(OK_HOME)} />));
      await waitFor(() => expect(screen.getByTestId("fe2-kpi-countdown")).toBeInTheDocument());
      expect(screen.queryByTestId("fe2-kpi-members")).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId("fe2-home-edit-toggle"));
      fireEvent.click(screen.getByTestId("fe2-home-edit-reset"));
      expect(useUiStore.getState().homeLayout).toEqual({ order: [], hidden: [] });
      expect(useUiStore.getState().homeDensity).toBe("comfortable");
      expect(screen.getByTestId("fe2-widget-edit-kpi-members")).toHaveAttribute("data-hidden", "false");
    });
  });
});
