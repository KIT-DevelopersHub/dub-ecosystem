// #880: マイタスク + ガント as one app — the ガント / カンバン tabs, the マイタスク kanban, and
// #881 edit rights on the kanban (locked cards, optimistic move + rollback).
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { common, identity, task } from "@dub/types";
import { ToastProvider } from "@dub/ui";
import { ApiClientProvider } from "../src/api/client-context";
import { MockApiClient } from "../src/api/mock-client";
import { ApiError } from "../src/contracts/spa-shell";
import { TaskRouteProvider, type TaskRouteContextValue } from "../src/routes/task-route-context";
import { TaskViewTabs } from "../src/components/TaskViewTabs";
import { MyTasksPage } from "../src/components/MyTasksPage";
import {
  canMoveCard,
  groupByStatus,
  isViewDisabled,
  KANBAN_COLUMNS,
  SELECTED_EVENT_STORAGE_KEY,
  taskHubPath,
} from "../src/domain/task-hub-view";
import { BOARD_COLUMNS } from "../src/domain/status-transitions";

const ME = "usr_me" as common.UserId;
const OTHER = "usr_other" as common.UserId;

const mk = (over: Partial<task.Task> & { id: string }): task.Task => ({
  eventId: "evt_1",
  title: `T-${over.id}`,
  description: null,
  status: "todo",
  priority: "medium",
  assigneeId: ME,
  teamId: null,
  createdBy: OTHER,
  dueAt: null,
  origin: "internal",
  archivedAt: null,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  version: 1,
  ...over,
});

afterEach(() => {
  localStorage.clear();
});

describe("task-hub-view (pure)", () => {
  it("kanban tab → /me/tasks; gantt tab → the event's gantt, else the /gantt landing", () => {
    expect(taskHubPath("kanban", "evt_1")).toBe("/me/tasks");
    expect(taskHubPath("gantt", "evt_1")).toBe("/events/evt_1/tasks/gantt");
    expect(taskHubPath("gantt", null)).toBe("/gantt");
  });

  it("a view is disabled only when the shell says its app is 無効", () => {
    expect(isViewDisabled("gantt", undefined)).toBe(false);
    expect(isViewDisabled("gantt", { gantt: false, kanban: true })).toBe(true);
    expect(isViewDisabled("kanban", { gantt: false, kanban: true })).toBe(false);
  });

  it("kanban columns are exactly the existing task statuses", () => {
    expect(KANBAN_COLUMNS).toEqual(BOARD_COLUMNS);
    const g = groupByStatus([mk({ id: "a" }), mk({ id: "b", status: "done" })]);
    expect(Object.keys(g)).toEqual([...BOARD_COLUMNS]);
    expect(g.todo.map((t) => t.id)).toEqual(["a"]);
    expect(g.done.map((t) => t.id)).toEqual(["b"]);
  });

  it("a card moves only when editable, allowed by the transition table, and not a no-op", () => {
    const t = mk({ id: "a", status: "todo" });
    expect(canMoveCard(t, "in_progress", () => true)).toBe(true);
    expect(canMoveCard(t, "in_progress", () => false)).toBe(false);
    expect(canMoveCard(t, "todo", () => true)).toBe(false);
  });
});

function renderTabs(value: "gantt" | "kanban", ctx: Partial<TaskRouteContextValue>, eventId?: string) {
  return render(
    <TaskRouteProvider value={{ currentUserId: ME, permissions: [], ...ctx }}>
      <TaskViewTabs value={value} {...(eventId ? { eventId } : {})} />
    </TaskRouteProvider>,
  );
}

describe("TaskViewTabs", () => {
  it("shows ガント and カンバン with the route's view selected", () => {
    renderTabs("gantt", {}, "evt_1");
    expect(screen.getByTestId("fe4-task-view-tabs-tab-gantt")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("fe4-task-view-tabs-tab-kanban")).toHaveAttribute("aria-selected", "false");
  });

  it("gantt → カンバン navigates to /me/tasks", () => {
    const navigate = vi.fn();
    renderTabs("gantt", { navigate }, "evt_1");
    fireEvent.click(screen.getByTestId("fe4-task-view-tabs-tab-kanban"));
    expect(navigate).toHaveBeenCalledWith("/me/tasks");
  });

  it("kanban → ガント opens the last selected event's gantt, or the landing when none", () => {
    const navigate = vi.fn();
    const { unmount } = renderTabs("kanban", { navigate });
    fireEvent.click(screen.getByTestId("fe4-task-view-tabs-tab-gantt"));
    expect(navigate).toHaveBeenLastCalledWith("/gantt");
    unmount();
    localStorage.setItem(SELECTED_EVENT_STORAGE_KEY, "evt_9");
    renderTabs("kanban", { navigate });
    fireEvent.click(screen.getByTestId("fe4-task-view-tabs-tab-gantt"));
    expect(navigate).toHaveBeenLastCalledWith("/events/evt_9/tasks/gantt");
  });

  it("clicking the active tab does nothing; a 無効 app's tab stays visible but disabled", () => {
    const navigate = vi.fn();
    renderTabs("kanban", { navigate, views: { gantt: false, kanban: true } });
    fireEvent.click(screen.getByTestId("fe4-task-view-tabs-tab-kanban"));
    const gantt = screen.getByTestId("fe4-task-view-tabs-tab-gantt");
    expect(gantt).toBeDisabled();
    fireEvent.click(gantt);
    expect(navigate).not.toHaveBeenCalled();
  });
});

function renderPage(client: MockApiClient, permissions: readonly identity.PermissionKey[]) {
  return render(
    <ApiClientProvider client={client}>
      <ToastProvider>
        <MyTasksPage currentUserId={ME} people={[]} teams={[]} permissions={permissions} />
      </ToastProvider>
    </ApiClientProvider>,
  );
}

describe("MyTasksPage kanban (#880 + #881 edit rights)", () => {
  const WRITE: identity.PermissionKey[] = ["task:read", "task:write"];

  it("places cards in their status column; my own task is movable", async () => {
    const client = new MockApiClient({ currentUserId: ME, tasks: [mk({ id: "t1" }), mk({ id: "t2", status: "in_progress" })] });
    renderPage(client, WRITE);
    const todo = await screen.findByTestId("fe4-kanban-column-todo");
    expect(within(todo).getByTestId("fe4-kanban-card-t1")).toHaveAttribute("data-editable", "true");
    expect(within(screen.getByTestId("fe4-kanban-column-in_progress")).getByTestId("fe4-kanban-card-t2")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-kanban-move-t1-trigger")).toBeInTheDocument();
  });

  it("a task I may not edit is shown locked (閲覧のみ, no 移動)", async () => {
    // requested lens: I created it, but the 依頼者 and 担当 are someone else → not mine to edit.
    const locked = mk({ id: "t3", createdBy: ME, requesterId: OTHER, assigneeId: OTHER });
    const client = new MockApiClient({ currentUserId: ME, tasks: [locked] });
    renderPage(client, WRITE);
    fireEvent.click(await screen.findByTestId("fe4-mytasks-lens-requested"));
    const card = await screen.findByTestId("fe4-kanban-card-t3");
    expect(card).toHaveAttribute("data-editable", "false");
    expect(screen.getByTestId("fe4-kanban-locked-t3")).toBeInTheDocument();
    expect(screen.queryByTestId("fe4-kanban-move-t3-trigger")).toBeNull();
  });

  it("without task:write every card is locked; task:edit_all unlocks others' tasks", async () => {
    const t = mk({ id: "t4", assigneeId: OTHER, requesterId: OTHER, createdBy: ME });
    const c1 = new MockApiClient({ currentUserId: ME, tasks: [mk({ id: "t5" })] });
    const r1 = renderPage(c1, ["task:read"]);
    expect(await screen.findByTestId("fe4-kanban-card-t5")).toHaveAttribute("data-editable", "false");
    r1.unmount();
    const c2 = new MockApiClient({ currentUserId: ME, tasks: [t] });
    renderPage(c2, [...WRITE, "task:edit_all"]);
    fireEvent.click(await screen.findByTestId("fe4-mytasks-lens-requested"));
    expect(await screen.findByTestId("fe4-kanban-card-t4")).toHaveAttribute("data-editable", "true");
  });

  it("移動 moves the card at once (optimistic) and keeps it after the server confirms", async () => {
    const client = new MockApiClient({ currentUserId: ME, tasks: [mk({ id: "t6" })] });
    renderPage(client, WRITE);
    fireEvent.click(await screen.findByTestId("fe4-kanban-move-t6-trigger"));
    fireEvent.click(screen.getByTestId("fe4-kanban-move-t6-in_progress"));
    expect(within(screen.getByTestId("fe4-kanban-column-in_progress")).getByTestId("fe4-kanban-card-t6")).toBeInTheDocument();
    await waitFor(async () => expect((await client.tasks.get<task.Task>("/t6")).status).toBe("in_progress"));
  });

  it("rolls the card back with an error toast when the update fails", async () => {
    const client = new MockApiClient({ currentUserId: ME, tasks: [mk({ id: "t7" })] });
    renderPage(client, WRITE);
    fireEvent.click(await screen.findByTestId("fe4-kanban-move-t7-trigger"));
    client.failNext = new ApiError(409, { error: { code: "VERSION_CONFLICT", message: "conflict", retryable: false } });
    fireEvent.click(screen.getByTestId("fe4-kanban-move-t7-done"));
    expect(await screen.findByText("状態を変更できませんでした")).toBeInTheDocument();
    expect(within(screen.getByTestId("fe4-kanban-column-todo")).getByTestId("fe4-kanban-card-t7")).toBeInTheDocument();
  });
});
