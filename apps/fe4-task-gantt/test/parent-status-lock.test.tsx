import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import type { common, task } from "@dub/types";
import { TaskDetailPanel } from "../src/components/TaskDetailPanel";
import type { ScopeTask } from "../src/domain/task-hierarchy";
import { renderWithProviders } from "./helpers-providers";

// 親タスク（子を持つ）のステータスは子孫タスクの内訳から自動集計される表示専用値
// （親バーの色分け・ドロップダウン表示＝domain/child-progress の再帰集計）。手動で編集できると
// 集計と食い違って挙動がおかしくなるため、子を1件以上持つ間はステータス編集を無効化する。
// 子タスク自身（親を持つがそれ自身は子を持たない）や、子が0件のトップレベルは従来どおり編集可。

const mkTask = (id: string, status: task.TaskStatus = "todo"): task.Task => ({
  id,
  eventId: "evt_1",
  title: id,
  description: null,
  status,
  priority: "medium",
  assigneeId: null,
  teamId: null,
  dueAt: "2026-08-20T00:00:00Z",
  origin: "internal",
  archivedAt: null,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
  version: 1,
});

const parentWithChildren: ScopeTask[] = [
  { id: "p" as common.TaskId, title: "親", parentTaskId: null, teamId: null },
  { id: "c1" as common.TaskId, title: "子1", parentTaskId: "p" as common.TaskId, teamId: null },
  { id: "c2" as common.TaskId, title: "子2", parentTaskId: "p" as common.TaskId, teamId: null },
];

describe("タスク詳細: 親タスク（子を持つ）のステータスは編集不可（自動集計）", () => {
  it("子を持つタスクのステータス欄は disabled＋ロック注記を表示する", () => {
    renderWithProviders(
      <TaskDetailPanel
        task={mkTask("p")}
        users={[]}
        canWrite
        canDelete
        onSave={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
        scopeTasks={parentWithChildren}
      />,
    );
    const statusSelect = screen.getByTestId("fe4-detail-status") as HTMLSelectElement;
    expect(statusSelect.disabled).toBe(true);
    expect(screen.getByTestId("fe4-detail-status-locked")).toBeInTheDocument();
  });

  it("子タスク自身（親はあるが子は持たない）のステータスは編集できる", () => {
    renderWithProviders(
      <TaskDetailPanel
        task={mkTask("c1")}
        users={[]}
        canWrite
        canDelete
        parentTaskId={"p" as common.TaskId}
        onSave={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
        scopeTasks={parentWithChildren}
      />,
    );
    const statusSelect = screen.getByTestId("fe4-detail-status") as HTMLSelectElement;
    expect(statusSelect.disabled).toBe(false);
    expect(screen.queryByTestId("fe4-detail-status-locked")).toBeNull();
  });

  it("子が0件のトップレベルタスクはステータスを編集できる（従来どおり）", () => {
    renderWithProviders(
      <TaskDetailPanel
        task={mkTask("solo")}
        users={[]}
        canWrite
        canDelete
        onSave={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
        scopeTasks={[{ id: "solo" as common.TaskId, title: "単独", parentTaskId: null, teamId: null }]}
      />,
    );
    const statusSelect = screen.getByTestId("fe4-detail-status") as HTMLSelectElement;
    expect(statusSelect.disabled).toBe(false);
    expect(screen.queryByTestId("fe4-detail-status-locked")).toBeNull();
  });

  it("最後の子が外れて0件になると、親だったタスクのステータスは編集可に戻る", () => {
    const { rerender } = renderWithProviders(
      <TaskDetailPanel
        task={mkTask("p")}
        users={[]}
        canWrite
        canDelete
        onSave={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
        scopeTasks={parentWithChildren}
      />,
    );
    expect((screen.getByTestId("fe4-detail-status") as HTMLSelectElement).disabled).toBe(true);

    // 子が全て外れた（scopeTasks が更新された）後の再描画。
    rerender(
      <TaskDetailPanel
        task={mkTask("p")}
        users={[]}
        canWrite
        canDelete
        onSave={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
        scopeTasks={[{ id: "p" as common.TaskId, title: "親", parentTaskId: null, teamId: null }]}
      />,
    );
    expect((screen.getByTestId("fe4-detail-status") as HTMLSelectElement).disabled).toBe(false);
    expect(screen.queryByTestId("fe4-detail-status-locked")).toBeNull();
  });

  it("canWrite=false のときは親でなくても従来どおり disabled（権限起因と自動集計起因は共存）", () => {
    renderWithProviders(
      <TaskDetailPanel
        task={mkTask("solo")}
        users={[]}
        canWrite={false}
        canDelete={false}
        onSave={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
        scopeTasks={[{ id: "solo" as common.TaskId, title: "単独", parentTaskId: null, teamId: null }]}
      />,
    );
    const statusSelect = screen.getByTestId("fe4-detail-status") as HTMLSelectElement;
    expect(statusSelect.disabled).toBe(true);
    // 権限不足であって「子を持つ」わけではないので、自動集計ロック注記は出さない。
    expect(screen.queryByTestId("fe4-detail-status-locked")).toBeNull();
  });
});
