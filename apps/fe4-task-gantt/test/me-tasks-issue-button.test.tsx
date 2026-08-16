import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import type { common, event } from "@dub/types";
import { ApiClientProvider } from "../src/api/client-context";
import { MockApiClient } from "../src/api/mock-client";
import { MeTasksRoute, TaskRouteProvider } from "../src/routes/taskRoutes";

// Regression for「adminなのに『タスクを発行』が押せない」: the button was disabled
// because MeTasksRoute handed events={[]} to MyTasksPage, so effectiveEvents stayed
// empty (no tasks to derive an event from either) and the button's
// disabled={effectiveEvents.length === 0} never cleared. The fix wires the real
// event list into the route.

const ME = "usr_me" as common.UserId;

const EVENTS: event.EventSummary[] = [
  { id: "evt_conf" as common.EventId, title: "北陸ITカンファレンス2026", phase: "planning", startsAt: null },
];

function renderRoute(client: MockApiClient, currentUserId: common.UserId | null = ME): ReactElement {
  return render(
    <ApiClientProvider client={client}>
      <TaskRouteProvider value={{ currentUserId, permissions: ["task:read", "task:write"] }}>
        <MeTasksRoute />
      </TaskRouteProvider>
    </ApiClientProvider>,
  ) as unknown as ReactElement;
}

describe("MeTasksRoute — 「タスクを発行」 is pressable for admins (issue fix)", () => {
  it("enables 「タスクを発行」 once the real event list loads", async () => {
    const client = new MockApiClient({ events: EVENTS, currentUserId: ME });
    renderRoute(client);

    const btn = await screen.findByTestId("fe4-mytasks-create-open");
    await waitFor(() => expect(btn).not.toBeDisabled());
  });

  it("opening the modal shows the fetched event as a 対象イベント option", async () => {
    const client = new MockApiClient({ events: EVENTS, currentUserId: ME });
    renderRoute(client);

    const btn = await screen.findByTestId("fe4-mytasks-create-open");
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);

    const eventSelect = await screen.findByTestId("fe4-mytask-create-event");
    expect(eventSelect).toHaveTextContent("北陸ITカンファレンス2026");
  });

  it("admin can press 発行 and issue a task — it lands in the list", async () => {
    const client = new MockApiClient({ events: EVENTS, currentUserId: ME });
    renderRoute(client);

    const openBtn = await screen.findByTestId("fe4-mytasks-create-open");
    await waitFor(() => expect(openBtn).not.toBeDisabled());
    fireEvent.click(openBtn);

    fireEvent.change(screen.getByTestId("fe4-mytask-create-title"), {
      target: { value: "登壇者へ最終案内メールを送る" },
    });
    // event is preselected to events[0]; requested lens shows tasks the user issued.
    const submit = screen.getByTestId("fe4-mytask-create-submit");
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    // POST /tasks was issued (created_by = current user), proving the button is live.
    await waitFor(() => {
      const created = client.calls.find((c) => c.path === "/api/v1/tasks" && c.method === "POST");
      expect(created).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("fe4-mytasks-lens-requested"));
    expect(await screen.findByText("登壇者へ最終案内メールを送る")).toBeInTheDocument();
  });

  it("regression: with no events and no tasks the button stays disabled (fallback path)", async () => {
    const client = new MockApiClient({ currentUserId: ME });
    renderRoute(client);
    const btn = await screen.findByTestId("fe4-mytasks-create-open");
    // give the (empty) fetches a tick to resolve before asserting it never enabled.
    await waitFor(() => expect(client.calls.some((c) => c.path === "/api/v1/events")).toBe(true));
    expect(btn).toBeDisabled();
  });
});
