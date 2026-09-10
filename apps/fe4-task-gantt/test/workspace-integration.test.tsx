import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { task, identity } from "@dub/types";
import { App } from "../src/App";
import { MockApiClient } from "../src/api/mock-client";

const EVENT = "evt_test";
const PERMS: identity.PermissionKey[] = ["task:read", "task:write", "task:delete"];

const mk = (
  id: string,
  title: string,
  status: task.TaskStatus,
  due: string,
  assigneeId: string | null = "usr_a",
): task.Task => ({
  id, eventId: EVENT, title, description: null, status,
  priority: "medium", assigneeId: assigneeId as task.Task["assigneeId"], dueAt: due, origin: "internal",
  archivedAt: null, createdAt: `2026-08-0${id.length}T00:00:00Z`, updatedAt: "2026-08-01T00:00:00Z", version: 1,
});

function seedClient(): MockApiClient {
  return new MockApiClient({
    users: [
      { id: "usr_a", displayName: "Alice", avatarUrl: null },
      { id: "usr_b", displayName: "Bob", avatarUrl: null },
    ],
    tasks: [
      mk("t1", "会場予約", "done", "2026-08-10T00:00:00Z"),
      mk("t2", "登壇者調整", "todo", "2026-08-20T00:00:00Z"),
      mk("t3", "会場設営", "todo", "2026-08-22T00:00:00Z", "usr_b"),
      mk("t4", "撤収作業", "todo", "2026-08-23T00:00:00Z", null),
    ],
  });
}

const renderApp = () => render(<App client={seedClient()} eventId={EVENT} permissions={PERMS} />);

describe("TaskWorkspacePage — gantt-only workspace", () => {
  it("renders the gantt with no list/board view switcher", async () => {
    renderApp();
    expect(await screen.findByTestId("fe4-gantt-view")).toBeInTheDocument();
    expect(screen.queryByTestId("fe4-view-switcher")).toBeNull();
    expect(await screen.findByTestId("fe4-gantt-row-t1")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-gantt-row-t2")).toBeInTheDocument();
  });

  it("keeps the day/week/month zoom control", async () => {
    renderApp();
    expect(await screen.findByTestId("fe4-gantt-zoom-day")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("fe4-gantt-zoom-day"));
    expect(screen.getByTestId("fe4-gantt-zoom-day")).toHaveAttribute("aria-selected", "true");
  });

  it("filters the bars by status and clears back", async () => {
    renderApp();
    await screen.findByTestId("fe4-gantt-row-t1");
    // narrow to done → only t1 remains
    fireEvent.click(screen.getByTestId("fe4-filter-status-done"));
    await waitFor(() => expect(screen.queryByTestId("fe4-gantt-row-t2")).toBeNull());
    expect(screen.getByTestId("fe4-gantt-row-t1")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-filter-count")).toHaveTextContent("1");
    // clear → both back
    fireEvent.click(screen.getByTestId("fe4-filter-clear"));
    await waitFor(() => expect(screen.getByTestId("fe4-gantt-row-t2")).toBeInTheDocument());
  });

  it("creates a task via the modal and it appears on the gantt", async () => {
    renderApp();
    await screen.findByTestId("fe4-gantt-row-t1");
    fireEvent.click(screen.getByTestId("fe4-create-open"));
    const modal = await screen.findByTestId("fe4-create-modal");
    fireEvent.change(within(modal).getByTestId("fe4-create-title"), { target: { value: "新しい打合せ" } });
    fireEvent.change(within(modal).getByTestId("fe4-create-due"), { target: { value: "2026-08-25" } });
    fireEvent.click(within(modal).getByTestId("fe4-create-submit"));
    expect((await screen.findAllByText("新しい打合せ")).length).toBeGreaterThan(0);
  });

  it("edits a task from the detail panel", async () => {
    renderApp();
    fireEvent.click(await screen.findByTestId("fe4-gantt-row-t2"));
    const panel = await screen.findByTestId("fe4-detail-panel");
    fireEvent.change(within(panel).getByTestId("fe4-detail-title"), { target: { value: "登壇者の最終調整" } });
    // no save button: the title edit auto-saves after the debounce
    expect((await screen.findAllByText("登壇者の最終調整")).length).toBeGreaterThan(0);
  });

  it("prefills the child-create modal's 担当 with the parent task's assignee", async () => {
    renderApp();
    fireEvent.click(await screen.findByTestId("fe4-gantt-row-t3")); // t3's assignee is usr_b (Bob)
    const panel = await screen.findByTestId("fe4-detail-panel");
    fireEvent.click(within(panel).getByTestId("fe4-detail-create-child"));
    const modal = await screen.findByTestId("fe4-create-modal");
    expect(within(modal).getByTestId("fe4-create-assignee")).toHaveValue("usr_b");
    // still user-editable: not locked to the preset.
    fireEvent.change(within(modal).getByTestId("fe4-create-assignee"), { target: { value: "usr_a" } });
    expect(within(modal).getByTestId("fe4-create-assignee")).toHaveValue("usr_a");
  });

  it("leaves the child-create modal's 担当 unassigned when the parent task has none", async () => {
    renderApp();
    fireEvent.click(await screen.findByTestId("fe4-gantt-row-t4")); // t4 has no assignee
    const panel = await screen.findByTestId("fe4-detail-panel");
    fireEvent.click(within(panel).getByTestId("fe4-detail-create-child"));
    const modal = await screen.findByTestId("fe4-create-modal");
    expect(within(modal).getByTestId("fe4-create-assignee")).toHaveValue("");
  });

  it("does not carry over a preset assignee into a plain (non-child) task creation", async () => {
    renderApp();
    // open+close a child-create (seeds usr_b), then open the plain create button —
    // the preset must not leak across flows.
    fireEvent.click(await screen.findByTestId("fe4-gantt-row-t3"));
    const panel = await screen.findByTestId("fe4-detail-panel");
    fireEvent.click(within(panel).getByTestId("fe4-detail-create-child"));
    const childModal = await screen.findByTestId("fe4-create-modal");
    fireEvent.click(within(childModal).getByTestId("fe4-create-cancel"));
    await waitFor(() => expect(screen.queryByTestId("fe4-create-modal")).toBeNull());

    fireEvent.click(screen.getByTestId("fe4-create-open"));
    const modal = await screen.findByTestId("fe4-create-modal");
    expect(within(modal).getByTestId("fe4-create-assignee")).toHaveValue("");
  });

  it("deletes a task from the detail panel", async () => {
    renderApp();
    fireEvent.click(await screen.findByTestId("fe4-gantt-row-t2"));
    fireEvent.click(await screen.findByTestId("fe4-detail-delete"));
    fireEvent.click(await screen.findByRole("button", { name: "削除する" })); // ConfirmDialog modal (#375)
    await waitFor(() => expect(screen.queryByTestId("fe4-gantt-row-t2")).toBeNull());
    expect(screen.getByTestId("fe4-gantt-row-t1")).toBeInTheDocument();
  });
});
