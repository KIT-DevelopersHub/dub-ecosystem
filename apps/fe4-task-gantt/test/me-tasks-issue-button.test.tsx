import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import type { common, event } from "@dub/types";
import { ApiClientProvider } from "../src/api/client-context";
import { MockApiClient } from "../src/api/mock-client";
import { MeTasksRoute, TaskRouteProvider } from "../src/routes/taskRoutes";

// 判断44 + taskform統一:「タスクを発行」is always pressable because a task's link to an
// event is now OPTIONAL — you can issue a standalone (unlinked) task. The event link is
// resolved from CONTEXT (never a visible field), so タスク発行 renders 寸分違わず同一 with
// the gantt タスク作成. The マイタスク hub is cross-event → no context event → unlinked task.

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

describe("MeTasksRoute — 「タスクを発行」 is pressable (unlinked-issue, context event)", () => {
  it("「タスクを発行」 is always pressable (no event/data precondition)", async () => {
    const client = new MockApiClient({ events: EVENTS, currentUserId: ME });
    renderRoute(client);

    const btn = await screen.findByTestId("fe4-mytasks-create-open");
    await waitFor(() => expect(btn).not.toBeDisabled());
  });

  it("the create modal shows NO 対象イベント field (event link is context-resolved)", async () => {
    const client = new MockApiClient({ events: EVENTS, currentUserId: ME });
    renderRoute(client);

    const btn = await screen.findByTestId("fe4-mytasks-create-open");
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);

    await screen.findByTestId("fe4-mytask-create-title");
    expect(screen.queryByTestId("fe4-mytask-create-event")).toBeNull();
  });

  it("admin can press 発行 and issue an unlinked task — it lands in the list", async () => {
    const client = new MockApiClient({ events: EVENTS, currentUserId: ME });
    renderRoute(client);

    const openBtn = await screen.findByTestId("fe4-mytasks-create-open");
    await waitFor(() => expect(openBtn).not.toBeDisabled());
    fireEvent.click(openBtn);

    fireEvent.change(screen.getByTestId("fe4-mytask-create-title"), {
      target: { value: "登壇者へ最終案内メールを送る" },
    });
    // Only the title gates submission (event comes from context, not the form).
    const submit = screen.getByTestId("fe4-mytask-create-submit");
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    // POST /tasks was issued (created_by = current user) with no eventId (unlinked).
    await waitFor(() => {
      const created = client.calls.find((c) => c.path === "/api/v1/tasks" && c.method === "POST");
      expect(created).toBeTruthy();
      expect((created?.body as { eventId?: string } | undefined)?.eventId).toBeUndefined();
    });
    fireEvent.click(screen.getByTestId("fe4-mytasks-lens-requested"));
    expect(await screen.findByText("登壇者へ最終案内メールを送る")).toBeInTheDocument();
  });

  it("判断44: with no events at all, the button is still pressable and issues an unlinked task", async () => {
    const client = new MockApiClient({ currentUserId: ME });
    renderRoute(client);
    const btn = await screen.findByTestId("fe4-mytasks-create-open");
    expect(btn).not.toBeDisabled();

    fireEvent.click(btn);
    fireEvent.change(screen.getByTestId("fe4-mytask-create-title"), {
      target: { value: "会場の下見をする" },
    });
    const submit = screen.getByTestId("fe4-mytask-create-submit");
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() => {
      const created = client.calls.find((c) => c.path === "/api/v1/tasks" && c.method === "POST");
      expect(created).toBeTruthy();
      expect((created?.body as { eventId?: string } | undefined)?.eventId).toBeUndefined();
    });
  });
});
