// UX for judgment 9-4 continuation: relation-type switching (依存↔親子), success
// toast on create + close-on-success, all via the existing detail-pane save path.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import type { task, identity } from "@dub/types";
import { TaskDetailPanel } from "../src/components/TaskDetailPanel";
import type { ScopeTask } from "../src/domain/task-hierarchy";
import { App } from "../src/App";
import { MockApiClient } from "../src/api/mock-client";
import { ApiError } from "../src/contracts/spa-shell";

beforeEach(() => localStorage.clear());

const mkTask = (id: string, over: Partial<task.Task> = {}): task.Task => ({
  id, eventId: "evt_1", title: id === "self" ? "対象タスク" : id, description: null, status: "todo",
  priority: "medium", assigneeId: null, dueAt: "2026-08-20T00:00:00Z", origin: "internal",
  archivedAt: null, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", version: 3, ...over,
});

describe("relation-type conversion in the detail pane", () => {
  it("依存→親子: 「親に」 promotes a predecessor to the parent and drops it from deps", () => {
    const onSave = vi.fn();
    // self + P are top-level siblings, so P is a valid predecessor of self.
    const scope: ScopeTask[] = [
      { id: "self", title: "対象タスク", parentTaskId: null },
      { id: "P", title: "親候補P", parentTaskId: null },
    ];
    render(
      <TaskDetailPanel
        task={mkTask("self")}
        users={[]}
        canWrite
        canDelete
        onSave={onSave}
        onDelete={() => {}}
        onClose={() => {}}
        parentOptions={[{ id: "P", title: "親候補P" }]}
        parentTaskId={null}
        dependsOnIds={["P"]}
        scopeTasks={scope}
      />,
    );
    fireEvent.click(screen.getByTestId("fe4-detail-deps-promote-P"));
    fireEvent.click(screen.getByTestId("fe4-detail-save"));
    const [patch, relations] = onSave.mock.calls[0]!;
    expect(patch.parentTaskId).toBe("P");           // P is now the parent
    expect(relations.parentChanged).toBe(true);
    expect(relations.parentTaskId).toBe("P");
    expect(relations.depsChanged).toBe(true);
    expect(relations.dependsOnIds).toEqual([]);      // P removed from predecessors
  });

  it("親子→依存: 「先行に変換」 detaches the parent and keeps it as a predecessor", () => {
    const onSave = vi.fn();
    const scope: ScopeTask[] = [
      { id: "self", title: "対象タスク", parentTaskId: "P" },
      { id: "P", title: "親P", parentTaskId: null },
    ];
    render(
      <TaskDetailPanel
        task={mkTask("self")}
        users={[]}
        canWrite
        canDelete
        onSave={onSave}
        onDelete={() => {}}
        onClose={() => {}}
        parentOptions={[{ id: "P", title: "親P" }]}
        parentTaskId={"P"}
        dependsOnIds={[]}
        scopeTasks={scope}
      />,
    );
    fireEvent.click(screen.getByTestId("fe4-detail-parent-to-dep"));
    fireEvent.click(screen.getByTestId("fe4-detail-save"));
    const [patch, relations] = onSave.mock.calls[0]!;
    expect(patch.parentTaskId).toBeNull();            // detached to top-level
    expect(relations.parentChanged).toBe(true);
    expect(relations.parentTaskId).toBeNull();
    expect(relations.depsChanged).toBe(true);
    expect(relations.dependsOnIds).toEqual(["P"]);    // old parent becomes a predecessor
  });

  it("the convert button only appears when a parent is set", () => {
    const base = {
      task: mkTask("self"), users: [] as identity.UserSummary[], canWrite: true, canDelete: true,
      onSave: () => {}, onDelete: () => {}, onClose: () => {},
      scopeTasks: [{ id: "self", title: "対象タスク", parentTaskId: null }] as ScopeTask[],
    };
    const { rerender } = render(<TaskDetailPanel {...base} parentTaskId={null} />);
    expect(screen.queryByTestId("fe4-detail-parent-to-dep")).toBeNull();
    rerender(<TaskDetailPanel {...base} key="p" parentTaskId={null} parentOptions={[{ id: "P", title: "P" }]} />);
    const parentInput = screen.getByTestId("fe4-detail-parent-input");
    fireEvent.focus(parentInput);
    fireEvent.change(parentInput, { target: { value: "P" } });
    fireEvent.mouseDown(screen.getByTestId("fe4-detail-parent-opt-P"));
    expect(screen.getByTestId("fe4-detail-parent-to-dep")).toBeInTheDocument();
  });
});

const EVENT = "evt_test";
const PERMS: identity.PermissionKey[] = ["task:read", "task:write", "task:delete"];
const seed = (): MockApiClient =>
  new MockApiClient({
    users: [{ id: "usr_a", displayName: "Alice", avatarUrl: null }],
    tasks: [mkTask("t1", { eventId: EVENT, title: "既存タスク" })],
  });

describe("create UI feedback (success toast + close-on-success)", () => {
  it("shows a success toast and closes the modal after a successful create", async () => {
    render(<App client={seed()} eventId={EVENT} permissions={PERMS} />);
    await screen.findByTestId("fe4-gantt-view");
    fireEvent.click(screen.getByTestId("fe4-create-open"));
    const modal = await screen.findByTestId("fe4-create-modal");
    fireEvent.change(within(modal).getByTestId("fe4-create-title"), { target: { value: "新規タスク" } });
    fireEvent.change(within(modal).getByTestId("fe4-create-due"), { target: { value: "2026-09-01" } });
    fireEvent.click(within(modal).getByTestId("fe4-create-submit"));
    // success toast appears…
    expect(await screen.findByTestId("toast-success")).toHaveTextContent("タスクを作成しました");
    // …and the modal closes
    await waitFor(() => expect(screen.queryByTestId("fe4-create-modal")).toBeNull());
  });

  it("keeps the modal open (no success toast) when the create fails", async () => {
    const client = seed();
    render(<App client={client} eventId={EVENT} permissions={PERMS} />);
    await screen.findByTestId("fe4-gantt-view");
    fireEvent.click(screen.getByTestId("fe4-create-open"));
    const modal = await screen.findByTestId("fe4-create-modal");
    fireEvent.change(within(modal).getByTestId("fe4-create-title"), { target: { value: "失敗する作成" } });
    client.failNext = new ApiError(400, { error: { code: "TASK_VALIDATION_FAILED", message: "入力内容を確認してください", retryable: false } });
    fireEvent.click(within(modal).getByTestId("fe4-create-submit"));
    // error dialog surfaces, modal stays open, no success toast
    await screen.findByTestId("fe4-error-dialog");
    expect(screen.getByTestId("fe4-create-modal")).toBeInTheDocument();
    expect(screen.queryByTestId("toast-success")).toBeNull();
  });
});
