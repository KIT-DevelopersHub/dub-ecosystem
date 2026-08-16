import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import type { common, event } from "@dub/types";
import { ApiClientProvider } from "../src/api/client-context";
import { MockApiClient } from "../src/api/mock-client";
import { MeTasksRoute, TaskRouteProvider } from "../src/routes/taskRoutes";

// Regression for「adminなのに『タスクを発行』が押せない」: the button was disabled
// whenever effectiveEvents was empty (no events in the org yet AND no tasks to
// derive one from) — the production case for a fresh admin, indistinguishable
// from「権限が無い」. The fix makes the button ALWAYS pressable and moves the
// no-events handling into the modal, which shows an イベント作成 導線 instead of a
// dead-end. The route still fetches the real event list so the 対象イベント select
// is populated when events do exist.

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

  it("regression: with no events and no tasks the button is STILL pressable (no dead-end)", async () => {
    // Reproduces the production case: a fresh admin whose org has no events yet and
    // who has issued no tasks. The button must not be a disabled dead-end (that read
    // as「権限が無い」to the user); it opens a modal that offers an イベント作成 導線.
    const client = new MockApiClient({ currentUserId: ME });
    renderRoute(client);
    const btn = await screen.findByTestId("fe4-mytasks-create-open");
    await waitFor(() => expect(client.calls.some((c) => c.path === "/api/v1/events")).toBe(true));
    expect(btn).not.toBeDisabled();
  });

  it("regression: with no events the modal shows an イベント作成 導線 instead of a submittable form", async () => {
    const client = new MockApiClient({ currentUserId: ME });
    renderRoute(client);

    const openBtn = await screen.findByTestId("fe4-mytasks-create-open");
    await waitFor(() => expect(client.calls.some((c) => c.path === "/api/v1/events")).toBe(true));
    fireEvent.click(openBtn);

    // empty state is shown; there is a 導線 to create an event, and NO 発行 submit.
    expect(await screen.findByTestId("fe4-mytask-create-no-events")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-mytask-create-go-event")).toBeInTheDocument();
    expect(screen.queryByTestId("fe4-mytask-create-submit")).not.toBeInTheDocument();
  });
});
