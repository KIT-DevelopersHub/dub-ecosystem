// P3-1: heading capture (readContentHeading), the live subscription hook
// (useRecentVisits), and the dashboard "最近開いた" card end-to-end (seed store →
// render HomeScreen → the rows render and click navigates via the shell router).
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { gateway } from "@dub/types";
import type { ApiClient } from "../lib/api-client.tsx";
import { __resetRecentVisitsCache, clearRecentVisits, recordVisit } from "../lib/recentVisits.ts";
import { HomeScreen } from "./screens/HomeScreen.tsx";
import { readContentHeading } from "./useVisitTracker.tsx";

beforeEach(() => {
  localStorage.clear();
  __resetRecentVisitsCache();
  document.body.innerHTML = "";
});

function makeApi(home: gateway.BffHomeResponse): ApiClient {
  return { bff: { home: () => Promise.resolve(home) } } as unknown as ApiClient;
}

function wrap(ui: ReactNode): JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

const HOME: gateway.BffHomeResponse = {
  upcomingEvents: [],
  unreadCount: 0,
  taskSummary: { total: 0, byStatus: { todo: 0, in_progress: 0, blocked: 0, done: 0, cancelled: 0 } },
  usageSummary: { metrics: [], worst: null },
  orgStats: { members: 0, teams: 0 },
  partialErrors: [],
};

describe("readContentHeading", () => {
  it("reads the content <PageHeader> h1 scoped to <main>", () => {
    document.body.innerHTML = `
      <div data-testid="fe2-shell-header">
        <div data-testid="dub-page-header-row"><h1>DevHub</h1></div>
      </div>
      <main>
        <div data-testid="dub-page-header-row"><h1>北陸ITカンファレンス</h1></div>
      </main>`;
    // The shell brand header ("DevHub") is outside <main> and must be ignored.
    expect(readContentHeading()).toBe("北陸ITカンファレンス");
  });

  it("returns null when there is no content heading", () => {
    document.body.innerHTML = `<main></main>`;
    expect(readContentHeading()).toBeNull();
  });
});

describe("HomeScreen 最近開いた card", () => {
  it("is absent when there is no history", async () => {
    render(wrap(<HomeScreen api={makeApi(HOME)} />));
    await waitFor(() => expect(screen.getByTestId("fe2-home")).toBeInTheDocument());
    expect(screen.queryByTestId("fe2-home-recent")).not.toBeInTheDocument();
  });

  it("renders recent visits and navigates on click", async () => {
    recordVisit({ path: "/events/e1", label: "北陸ITカンファレンス", app: "イベント", icon: "calendar" });
    recordVisit({ path: "/chat/c1", label: "general", app: "チャット", icon: "message-square" });
    const onNavigate = vi.fn();
    render(wrap(<HomeScreen api={makeApi(HOME)} onNavigate={onNavigate} />));

    const card = await screen.findByTestId("fe2-home-recent");
    expect(card).toBeInTheDocument();
    // Most-recent-first ordering.
    expect(screen.getByText("general")).toBeInTheDocument();
    expect(screen.getByText("北陸ITカンファレンス")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("fe2-home-recent-item-/events/e1"));
    expect(onNavigate).toHaveBeenCalledWith("/events/e1");
  });

  it("updates live when a new visit is recorded", async () => {
    render(wrap(<HomeScreen api={makeApi(HOME)} />));
    await waitFor(() => expect(screen.getByTestId("fe2-home")).toBeInTheDocument());
    expect(screen.queryByTestId("fe2-home-recent")).not.toBeInTheDocument();

    act(() => recordVisit({ path: "/members/u1", label: "田中", app: "運営メンバー・名簿", icon: "users" }));
    expect(await screen.findByTestId("fe2-home-recent")).toBeInTheDocument();
    expect(screen.getByText("田中")).toBeInTheDocument();

    act(() => clearRecentVisits());
    await waitFor(() => expect(screen.queryByTestId("fe2-home-recent")).not.toBeInTheDocument());
  });
});
