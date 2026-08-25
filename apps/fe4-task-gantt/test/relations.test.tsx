import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { identity, task, team } from "@dub/types";
import { TaskCreateModal, type TaskDraft } from "../src/components/TaskCreateModal";
import { TaskDetailPanel } from "../src/components/TaskDetailPanel";
import type { ScopeTask } from "../src/domain/task-hierarchy";
import { App } from "../src/App";
import { MockApiClient } from "../src/api/mock-client";

beforeEach(() => localStorage.clear());

// Team A: P(top) ┐   Team B: Q(top) ┐
//         c1,c2 ┘            d1      ┘
const SCOPE: ScopeTask[] = [
  { id: "P", title: "親P", parentTaskId: null, teamId: "A" },
  { id: "Q", title: "親Q", parentTaskId: null, teamId: "B" },
  { id: "c1", title: "子1", parentTaskId: "P", teamId: "A" },
  { id: "c2", title: "子2", parentTaskId: "P", teamId: "A" },
  { id: "d1", title: "子D", parentTaskId: "Q", teamId: "B" },
];
const PARENT_OPTS = SCOPE.map((s) => ({ id: s.id, title: s.title }));
const TEAMS: team.Team[] = [
  { id: "A", key: "a", name: "チームA" },
  { id: "B", key: "b", name: "チームB" },
];

describe("TaskCreateModal — 親タスク then 先行タスク (feature #1 + ADR-0007 team scope)", () => {
  it("selecting a team scopes the predecessor options to that team (across scopes)", () => {
    render(
      <TaskCreateModal
        open
        onClose={() => {}}
        users={[]}
        teams={TEAMS}
        parentOptions={PARENT_OPTS}
        scopeTasks={SCOPE}
        onCreate={async () => {}}
      />,
    );
    // choose team A (the dependency boundary — parent no longer scopes deps)
    fireEvent.change(screen.getByTestId("fe4-create-team"), { target: { value: "A" } });
    const depInput = screen.getByTestId("fe4-create-deps-input");
    fireEvent.focus(depInput);
    fireEvent.change(depInput, { target: { value: "子" } }); // matches 子1/子2/子D by title
    // team-A tasks across scopes are offered; d1 (team B) is excluded
    expect(screen.getByTestId("fe4-create-deps-opt-c1")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-create-deps-opt-c2")).toBeInTheDocument();
    expect(screen.queryByTestId("fe4-create-deps-opt-d1")).toBeNull();
  });

  it("submits the chosen parent as draft.parentTaskId", async () => {
    const onCreate = vi.fn((_draft: TaskDraft) => Promise.resolve());
    render(
      <TaskCreateModal
        open
        onClose={() => {}}
        users={[]}
        teams={[]}
        parentOptions={PARENT_OPTS}
        scopeTasks={SCOPE}
        onCreate={onCreate}
      />,
    );
    fireEvent.change(screen.getByTestId("fe4-create-title"), { target: { value: "新タスク" } });
    fireEvent.change(screen.getByTestId("fe4-create-parent"), { target: { value: "P" } });
    fireEvent.click(screen.getByTestId("fe4-create-submit"));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0]![0].parentTaskId).toBe("P");
  });
});

const mkTask = (id: string): task.Task => ({
  id, eventId: "evt_1", title: id === "self" ? "対象タスク" : id, description: null, status: "todo",
  priority: "medium", assigneeId: null, dueAt: "2026-08-20T00:00:00Z", origin: "internal",
  archivedAt: null, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", version: 3,
});

describe("TaskDetailPanel — edit 先行/親子 + create predecessor (feature #2)", () => {
  it("renders the 先行タスクを作成 action and passes this task id", () => {
    const onCreatePredecessor = vi.fn();
    render(
      <TaskDetailPanel
        task={mkTask("self")}
        users={[]}
        canWrite
        canDelete
        onSave={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
        onCreateChild={() => {}}
        onCreatePredecessor={onCreatePredecessor}
      />,
    );
    const btn = screen.getByTestId("fe4-detail-create-predecessor");
    expect(within(btn).getByText(/先行タスクを作成/)).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onCreatePredecessor).toHaveBeenCalledWith("self");
  });

  it("changing the parent flags a re-parent in the save payload", () => {
    const onSave = vi.fn();
    render(
      <TaskDetailPanel
        task={mkTask("self")}
        users={[]}
        canWrite
        canDelete
        onSave={onSave}
        onDelete={() => {}}
        onClose={() => {}}
        parentOptions={[{ id: "P", title: "親P" }, { id: "Q", title: "親Q" }]}
        parentTaskId={null}
        scopeTasks={[{ id: "self", title: "対象タスク", parentTaskId: null, teamId: null }, { id: "P", title: "親P", parentTaskId: null, teamId: null }]}
      />,
    );
    fireEvent.change(screen.getByTestId("fe4-detail-parent"), { target: { value: "P" } });
    fireEvent.click(screen.getByTestId("fe4-detail-save"));
    expect(onSave).toHaveBeenCalled();
    const [patch, relations] = onSave.mock.calls[0]!;
    expect(patch.parentTaskId).toBe("P");
    expect(relations.parentChanged).toBe(true);
    expect(relations.parentTaskId).toBe("P");
  });

  it("adding a predecessor flags a dependency change (先行タスク編集)", () => {
    const onSave = vi.fn();
    render(
      <TaskDetailPanel
        task={mkTask("self")}
        users={[]}
        canWrite
        canDelete
        onSave={onSave}
        onDelete={() => {}}
        onClose={() => {}}
        parentTaskId={null}
        dependsOnIds={[]}
        scopeTasks={[
          { id: "self", title: "対象タスク", parentTaskId: null, teamId: null },
          { id: "sib", title: "兄弟タスク", parentTaskId: null, teamId: null },
        ]}
      />,
    );
    const input = screen.getByTestId("fe4-detail-deps-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "兄弟" } });
    fireEvent.mouseDown(screen.getByTestId("fe4-detail-deps-opt-sib"));
    fireEvent.click(screen.getByTestId("fe4-detail-save"));
    const [, relations] = onSave.mock.calls[0]!;
    expect(relations.depsChanged).toBe(true);
    expect(relations.dependsOnIds).toContain("sib");
  });
});

// ---- workspace integration: create-with-parent + detail predecessor edit ----
const EVENT = "evt_ws";
const PERMS: identity.PermissionKey[] = ["task:read", "task:write", "task:delete"];
const wsTask = (id: string, title: string): task.Task => ({
  id, eventId: EVENT, title, description: null, status: "todo",
  priority: "medium", assigneeId: null, dueAt: "2026-08-20T00:00:00Z", origin: "internal",
  archivedAt: null, createdAt: `2026-08-0${id.length}T00:00:00Z`, updatedAt: "2026-08-01T00:00:00Z", version: 1,
});
const wsClient = () => new MockApiClient({ tasks: [wsTask("t1", "会場予約"), wsTask("t2", "登壇者調整")] });

describe("TaskWorkspacePage — create under a parent, edit predecessors from detail", () => {
  it("creating a task under a parent makes the parent a collapsible work-package", async () => {
    render(<App client={wsClient()} eventId={EVENT} permissions={PERMS} />);
    await screen.findByTestId("fe4-gantt-row-t1");
    fireEvent.click(screen.getByTestId("fe4-create-open"));
    const modal = await screen.findByTestId("fe4-create-modal");
    fireEvent.change(within(modal).getByTestId("fe4-create-title"), { target: { value: "小タスク" } });
    fireEvent.change(within(modal).getByTestId("fe4-create-parent"), { target: { value: "t1" } });
    fireEvent.click(within(modal).getByTestId("fe4-create-submit"));
    // t1 now owns a child → renders the expand/collapse toggle
    expect(await screen.findByTestId("fe4-gantt-toggle-t1")).toBeInTheDocument();
    // a task that JUST became a parent auto-expands, so the new child is visible at
    // once — no extra click needed (regression: the toggle used to stay collapsed and
    // the freshly-added child was hidden with no way to see it optimistically).
    expect((await screen.findAllByText("小タスク")).length).toBeGreaterThan(0);
    // and the toggle still works: collapsing it hides the child again.
    fireEvent.click(screen.getByTestId("fe4-gantt-toggle-t1"));
    await waitFor(() => expect(screen.queryByText("小タスク")).not.toBeInTheDocument());
  });

  it("adding a predecessor from the detail panel draws the dependency arrow", async () => {
    render(<App client={wsClient()} eventId={EVENT} permissions={PERMS} />);
    fireEvent.click(await screen.findByTestId("fe4-gantt-row-t2"));
    const panel = await screen.findByTestId("fe4-detail-panel");
    const input = within(panel).getByTestId("fe4-detail-deps-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "会場" } }); // t1 = 会場予約 (same top-level scope)
    fireEvent.mouseDown(within(panel).getByTestId("fe4-detail-deps-opt-t1"));
    fireEvent.click(within(panel).getByTestId("fe4-detail-save"));
    // t1 -> t2 dependency now rendered on the timeline
    expect(await screen.findByTestId("fe4-gantt-dep-t1->t2")).toBeInTheDocument();
  });

  it("confirms a saved predecessor edit with a success toast (楽観的UIの成功フィードバック)", async () => {
    render(<App client={wsClient()} eventId={EVENT} permissions={PERMS} />);
    fireEvent.click(await screen.findByTestId("fe4-gantt-row-t2"));
    const panel = await screen.findByTestId("fe4-detail-panel");
    const input = within(panel).getByTestId("fe4-detail-deps-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "会場" } });
    fireEvent.mouseDown(within(panel).getByTestId("fe4-detail-deps-opt-t1"));
    fireEvent.click(within(panel).getByTestId("fe4-detail-save"));
    // the dependency arrow + a success toast both appear (no silent, latent save)
    expect(await screen.findByTestId("fe4-gantt-dep-t1->t2")).toBeInTheDocument();
    expect(await screen.findByTestId("toast-success")).toBeInTheDocument();
  });
});
