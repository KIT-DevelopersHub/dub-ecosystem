import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import type { common, event } from "@dub/types";
import { ApiClientProvider } from "../src/api/client-context";
import { MockApiClient } from "../src/api/mock-client";
import { MeTasksRoute, TaskRouteProvider } from "../src/routes/taskRoutes";

// 判断44:「タスクを発行」is always pressable because a task's link to an event is now
// OPTIONAL — you can issue a standalone (unlinked) task. This supersedes the earlier
// events-driven disable (the root of「adminなのに押せない」): there is no longer any
// data/permission precondition on issuing a task. Event linking remains available as an
// optional「対象イベント（任意）」selector when events exist.

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
    // event link defaults to「紐付けない」(optional); only the title gates submission.
    const submit = screen.getByTestId("fe4-mytask-create-submit");
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    // POST /tasks was issued (created_by = current user), proving the button is live.
    await waitFor(() => {
      const created = client.calls.find((c) => c.path === "/api/v1/tasks" && c.method === "POST");
      expect(created).toBeTruthy();
    });
    // 単一の「すべて」ビューなので、発行したタスクはタブ切替なしでそのまま一覧に出る。
    expect(await screen.findByText("登壇者へ最終案内メールを送る")).toBeInTheDocument();
  });

  it("判断44: with no events at all, the button is still pressable and can issue an unlinked task", async () => {
    const client = new MockApiClient({ currentUserId: ME });
    renderRoute(client);
    const btn = await screen.findByTestId("fe4-mytasks-create-open");
    // No events/tasks precondition — the button never gets disabled now.
    await waitFor(() => expect(client.calls.some((c) => c.path === "/api/v1/events")).toBe(true));
    expect(btn).not.toBeDisabled();

    // Open the modal and issue a task WITHOUT selecting an event (default 紐付けない).
    fireEvent.click(btn);
    fireEvent.change(screen.getByTestId("fe4-mytask-create-title"), {
      target: { value: "会場の下見をする" },
    });
    const submit = screen.getByTestId("fe4-mytask-create-submit");
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    // POST /tasks was issued with no eventId (unlinked task).
    await waitFor(() => {
      const created = client.calls.find((c) => c.path === "/api/v1/tasks" && c.method === "POST");
      expect(created).toBeTruthy();
      expect((created?.body as { eventId?: string } | undefined)?.eventId).toBeUndefined();
    });
  });
});
