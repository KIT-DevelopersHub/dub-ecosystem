import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders } from "./helpers-providers";
import type { common, task, team } from "@dub/types";
import { MyTaskCreateModal, type MyTaskDraft } from "../src/components/MyTaskCreateModal";
import { TaskDetailPanel } from "../src/components/TaskDetailPanel";

// 親タスクと子タスクは必ず同じチーム:
//   1. 親から「子タスクを作成」で開くと、子のチームは親のチームで自動入力される。
//   2. 子タスクのチーム欄は変更できない（disabled・親追従）。
//   3. 親を持つタスクの詳細でもチームは親に固定され、変更不可。
// 既存のクロスチーム依存制約（依存は同一チームのみ）と整合。

const TEAMS: team.Team[] = [
  { id: "team_hq" as common.TeamId, key: "hq", name: "統括チーム" },
  { id: "team_dev" as common.TeamId, key: "dev", name: "開発チーム" },
];

describe("子タスク作成モーダル: チームは親に固定（自動入力＋変更不可）", () => {
  it("lockTeamToParent + parentTeamId で、チーム欄が親のチームでプリフィルされ disabled になる", () => {
    render(
      <MyTaskCreateModal
        open
        onClose={() => {}}
        events={[]}
        people={[]}
        teams={TEAMS}
        onCreate={async () => {}}
        lockTeamToParent
        parentTeamId={"team_dev" as common.TeamId}
      />,
    );
    const teamSelect = screen.getByTestId("fe4-mytask-create-team") as HTMLSelectElement;
    // 1. 子のチーム = 親のチーム（開発チーム）で自動入力される。
    expect(teamSelect.value).toBe("team_dev");
    // 2. 変更できない（disabled）＋ロック注記を表示。
    expect(teamSelect.disabled).toBe(true);
    expect(screen.getByTestId("fe4-mytask-create-team-locked")).toBeInTheDocument();
  });

  it("submit で送信される teamId は親のチーム（フォームを触っても親追従）", async () => {
    const onCreate = vi.fn(async (_d: MyTaskDraft) => {});
    render(
      <MyTaskCreateModal
        open
        onClose={() => {}}
        events={[]}
        people={[]}
        teams={TEAMS}
        onCreate={onCreate}
        lockTeamToParent
        parentTeamId={"team_hq" as common.TeamId}
      />,
    );
    fireEvent.change(screen.getByTestId("fe4-mytask-create-title"), { target: { value: "子タスク" } });
    fireEvent.click(screen.getByTestId("fe4-mytask-create-submit"));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    const draft = onCreate.mock.calls[0]![0];
    expect(draft.teamId).toBe("team_hq");
  });

  it("親なし（通常作成）ではチーム欄は編集可能（従来どおり）", () => {
    render(
      <MyTaskCreateModal
        open
        onClose={() => {}}
        events={[]}
        people={[]}
        teams={TEAMS}
        onCreate={async () => {}}
        defaultTeamId={"team_hq" as common.TeamId}
      />,
    );
    const teamSelect = screen.getByTestId("fe4-mytask-create-team") as HTMLSelectElement;
    expect(teamSelect.disabled).toBe(false);
    expect(screen.queryByTestId("fe4-mytask-create-team-locked")).toBeNull();
  });
});

const mkTask = (id: string, teamId: string | null): task.Task => ({
  id, eventId: "evt_1", title: "子タスク", description: null, status: "todo",
  priority: "medium", assigneeId: null, teamId: (teamId ?? undefined) as common.TeamId | undefined,
  dueAt: "2026-08-20T00:00:00Z", origin: "internal", archivedAt: null,
  createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", version: 1,
});

describe("タスク詳細: 子タスク（親あり）のチームは親に固定で変更不可", () => {
  const scope = [
    { id: "p", title: "親", parentTaskId: null, teamId: "team_dev" as common.TeamId },
    { id: "c", title: "子", parentTaskId: "p", teamId: "team_dev" as common.TeamId },
  ];

  it("親を持つタスクのチーム欄は disabled＋ロック注記を表示", () => {
    renderWithProviders(
      <TaskDetailPanel
        task={mkTask("c", "team_dev")}
        users={[]}
        teams={TEAMS}
        canWrite
        canDelete
        parentTaskId={"p" as common.TaskId}
        onSave={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
        scopeTasks={scope}
      />,
    );
    const teamSelect = screen.getByTestId("fe4-detail-team") as HTMLSelectElement;
    expect(teamSelect.value).toBe("team_dev");
    expect(teamSelect.disabled).toBe(true);
    expect(screen.getByTestId("fe4-detail-team-locked")).toBeInTheDocument();
  });

  it("トップレベル（親なし）のタスクはチームを編集できる", () => {
    renderWithProviders(
      <TaskDetailPanel
        task={mkTask("t", "team_dev")}
        users={[]}
        teams={TEAMS}
        canWrite
        canDelete
        parentTaskId={null}
        onSave={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
        scopeTasks={[{ id: "t", title: "単独", parentTaskId: null, teamId: "team_dev" as common.TeamId }]}
      />,
    );
    const teamSelect = screen.getByTestId("fe4-detail-team") as HTMLSelectElement;
    expect(teamSelect.disabled).toBe(false);
    expect(screen.queryByTestId("fe4-detail-team-locked")).toBeNull();
  });
});
