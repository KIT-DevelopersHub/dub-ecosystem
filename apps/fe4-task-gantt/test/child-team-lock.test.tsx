import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import type { common, task, team } from "@dub/types";
import { TaskCreateModal, type TaskDraft } from "../src/components/TaskCreateModal";
import { TaskDetailPanel } from "../src/components/TaskDetailPanel";
import type { ScopeTask } from "../src/domain/task-hierarchy";
// TaskDetailPanel now embeds the attachments editor (useApiClient) + optimistic toasts,
// so it must render inside ApiClientProvider/ToastProvider. Use the shared test wrapper.
import { renderWithProviders } from "./helpers-providers";

// 親タスクと子タスクは必ず同じチーム:
//   1. 親をプリセットして「タスクを作成」を開くと、子のチームは親のチームになる。
//   2. 親がいる間は担当を変えてもチームは親のまま（チーム欄そのものは出さない・担当に従う）。
//   3. 親を持つタスクの詳細でもチームは親に固定（右上のチームバッジは親のチーム）。
// 既存のクロスチーム依存制約（依存は同一チームのみ）と整合。

const TEAMS: team.Team[] = [
  { id: "team_hq" as common.TeamId, key: "hq", name: "統括チーム" },
  { id: "team_dev" as common.TeamId, key: "dev", name: "開発チーム" },
];

const SCOPE: ScopeTask[] = [
  { id: "p" as common.TaskId, title: "親", parentTaskId: null, teamId: "team_dev" as common.TeamId },
];

describe("タスク作成モーダル: 親をプリセットするとチームは親に固定（自動入力＋変更不可）", () => {
  it("initialParentId で開いてもチーム欄は出さず、チーム担当を選んでも teamId は親のチームのまま", async () => {
    const onCreate = vi.fn(async (_d: TaskDraft) => {});
    renderWithProviders(
      <TaskCreateModal
        open
        onClose={() => {}}
        users={[]}
        teams={TEAMS}
        parentOptions={[{ id: "p" as common.TaskId, title: "親" }]}
        scopeTasks={SCOPE}
        onCreate={onCreate}
        initialParentId={"p" as common.TaskId}
      />,
    );
    expect(screen.queryByTestId("fe4-create-team")).toBeNull();
    fireEvent.change(screen.getByTestId("fe4-create-title"), { target: { value: "子タスク" } });
    fireEvent.click(screen.getByTestId("fe4-create-assignee-trigger"));
    fireEvent.click(screen.getByTestId("fe4-create-assignee-option-team:team_hq"));
    fireEvent.click(screen.getByTestId("fe4-create-submit"));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]![0]).toMatchObject({ teamId: "team_dev", assigneeTeamId: "team_hq" });
  });

  it("submit で送信される teamId は親のチーム（フォームを触っても親追従）", async () => {
    const onCreate = vi.fn(async (_d: TaskDraft) => {});
    renderWithProviders(
      <TaskCreateModal
        open
        onClose={() => {}}
        users={[]}
        teams={TEAMS}
        parentOptions={[{ id: "p" as common.TaskId, title: "親" }]}
        scopeTasks={SCOPE}
        onCreate={onCreate}
        initialParentId={"p" as common.TaskId}
        defaultAssignee={{ assigneeId: null, assigneeTeamId: "team_hq" as common.TeamId }}
      />,
    );
    fireEvent.change(screen.getByTestId("fe4-create-title"), { target: { value: "子タスク" } });
    fireEvent.click(screen.getByTestId("fe4-create-submit"));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    const draft = onCreate.mock.calls[0]![0];
    expect(draft.teamId).toBe("team_dev");
    expect(draft.parentTaskId).toBe("p");
  });

  it("親なし（トップレベル作成）では teamId は担当のチームに従う", async () => {
    const onCreate = vi.fn(async (_d: TaskDraft) => {});
    renderWithProviders(
      <TaskCreateModal open onClose={() => {}} users={[]} teams={TEAMS} parentOptions={[]} scopeTasks={[]} onCreate={onCreate} />,
    );
    fireEvent.change(screen.getByTestId("fe4-create-title"), { target: { value: "単独" } });
    fireEvent.click(screen.getByTestId("fe4-create-assignee-trigger"));
    fireEvent.click(screen.getByTestId("fe4-create-assignee-option-team:team_hq"));
    fireEvent.click(screen.getByTestId("fe4-create-submit"));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]![0].teamId).toBe("team_hq");
  });
});

const mkTask = (id: string, teamId: string | null): task.Task => ({
  id,
  eventId: "evt_1",
  title: "子タスク",
  description: null,
  status: "todo",
  priority: "medium",
  assigneeId: null,
  teamId: (teamId ?? undefined) as common.TeamId | undefined,
  dueAt: "2026-08-20T00:00:00Z",
  origin: "internal",
  archivedAt: null,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
  version: 1,
});

describe("タスク詳細: 子タスク（親あり）のチームは親に固定で変更不可", () => {
  const scope: ScopeTask[] = [
    { id: "p" as common.TaskId, title: "親", parentTaskId: null, teamId: "team_dev" as common.TeamId },
    { id: "c" as common.TaskId, title: "子", parentTaskId: "p" as common.TaskId, teamId: "team_dev" as common.TeamId },
  ];

  it("親を持つタスク: チーム欄は無く、チーム担当に変えても teamId は親のチームのまま", async () => {
    const onSave = vi.fn();
    renderWithProviders(
      <TaskDetailPanel
        task={mkTask("c", "team_dev")}
        users={[]}
        teams={TEAMS}
        canWrite
        canDelete
        parentTaskId={"p" as common.TaskId}
        onSave={onSave}
        onDelete={() => {}}
        onClose={() => {}}
        scopeTasks={scope}
        autosaveDebounceMs={0}
      />,
    );
    expect(screen.queryByTestId("fe4-detail-team")).toBeNull();
    expect(screen.getByTestId("fe4-detail-team-badge")).toHaveTextContent("開発チーム");
    fireEvent.click(screen.getByTestId("fe4-detail-assignee-trigger"));
    fireEvent.click(screen.getByTestId("fe4-detail-assignee-option-team:team_hq"));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const [patch] = onSave.mock.calls.at(-1)!;
    expect(patch).toMatchObject({ assigneeTeamId: "team_hq" });
    expect(patch).not.toHaveProperty("teamId");
    expect(screen.getByTestId("fe4-detail-team-badge")).toHaveTextContent("開発チーム");
  });

  it("トップレベル（親なし）のタスク: チーム担当に変えると teamId とバッジがそのチームになる", async () => {
    const onSave = vi.fn();
    renderWithProviders(
      <TaskDetailPanel
        task={mkTask("t", "team_dev")}
        users={[]}
        teams={TEAMS}
        canWrite
        canDelete
        parentTaskId={null}
        onSave={onSave}
        onDelete={() => {}}
        onClose={() => {}}
        scopeTasks={[{ id: "t" as common.TaskId, title: "単独", parentTaskId: null, teamId: "team_dev" as common.TeamId }]}
        autosaveDebounceMs={0}
      />,
    );
    expect(screen.getByTestId("fe4-detail-team-badge")).toHaveTextContent("開発チーム");
    fireEvent.click(screen.getByTestId("fe4-detail-assignee-trigger"));
    fireEvent.click(screen.getByTestId("fe4-detail-assignee-option-team:team_hq"));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls.at(-1)![0]).toMatchObject({ assigneeTeamId: "team_hq", teamId: "team_hq" });
    expect(screen.getByTestId("fe4-detail-team-badge")).toHaveTextContent("統括チーム");
  });
});
