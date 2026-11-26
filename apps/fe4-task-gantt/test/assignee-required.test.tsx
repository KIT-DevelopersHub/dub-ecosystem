// 担当は必須 (人 or チーム): 作成=発行フォームに「未割当」は無く、担当が無いと作成できない。
// 既定値はチーム絞り込み中ならそのチーム・なければ作成者。担当なしの古いタスクは表示はされ、
// 詳細で担当を選ぶまで変更を保存しない。
import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { common, identity, task, team } from "@dub/types";
import { renderWithProviders as render } from "./helpers-providers";
import { TaskCreateModal, type TaskDraft } from "../src/components/TaskCreateModal";
import { MyTaskCreateModal, type MyTaskDraft } from "../src/components/MyTaskCreateModal";
import { TaskDetailPanel } from "../src/components/TaskDetailPanel";
import { defaultAssignee, hasAssignee, UNASSIGNED } from "../src/domain/assignee";

const ME = "usr_me" as common.UserId;
const USERS: identity.UserSummary[] = [
  { id: ME, displayName: "自分", avatarUrl: null },
  { id: "usr_bob" as common.UserId, displayName: "ボブ", avatarUrl: null },
];
const TEAMS = [
  { id: "team_ops", name: "運営", color: "#123456" },
  { id: "team_dev", name: "開発", color: "#654321" },
] as unknown as team.Team[];

describe("defaultAssignee (既定の担当)", () => {
  it("team-filtered gantt → that team", () => {
    expect(defaultAssignee(ME, USERS, { teamId: "team_ops" as common.TeamId, teams: TEAMS })).toEqual({
      assigneeId: null,
      assigneeTeamId: "team_ops",
    });
  });
  it("no team filter → the creator", () => {
    expect(defaultAssignee(ME, USERS, { teamId: undefined, teams: TEAMS })).toEqual({ assigneeId: ME, assigneeTeamId: null });
  });
  it("an unknown filter team or a creator outside the candidates → nothing (must choose)", () => {
    expect(defaultAssignee(ME, [], { teamId: "team_gone" as common.TeamId, teams: TEAMS })).toEqual(UNASSIGNED);
    expect(defaultAssignee(null, USERS)).toEqual(UNASSIGNED);
    expect(hasAssignee(UNASSIGNED)).toBe(false);
  });
});

describe("TaskCreateModal (タスク作成) — 担当は必須", () => {
  const renderModal = (onCreate: (d: TaskDraft) => Promise<void>, def = UNASSIGNED) =>
    render(
      <TaskCreateModal
        open
        onClose={() => {}}
        users={USERS}
        teams={TEAMS}
        parentOptions={[]}
        scopeTasks={[]}
        onCreate={onCreate}
        defaultAssignee={def}
      />,
    );

  it("without an assignee: required mark + inline error, submit disabled, no 未割当 option", async () => {
    const onCreate = vi.fn(async (_d: TaskDraft) => {});
    renderModal(onCreate);
    fireEvent.change(screen.getByTestId("fe4-create-title"), { target: { value: "T" } });
    expect(screen.getByTestId("fe4-create-assignee-error")).toHaveTextContent("担当（人またはチーム）を選んでください");
    expect(screen.getByTestId("fe4-create-submit")).toBeDisabled();
    fireEvent.click(screen.getByTestId("fe4-create-assignee-trigger"));
    const list = await screen.findByRole("listbox");
    expect(within(list).queryByRole("option", { name: "未割当" })).toBeNull();
    // choosing one unblocks submit
    fireEvent.click(screen.getByTestId("fe4-create-assignee-option-user:usr_bob"));
    expect(screen.queryByTestId("fe4-create-assignee-error")).toBeNull();
    fireEvent.click(screen.getByTestId("fe4-create-submit"));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]![0]).toMatchObject({ assigneeId: "usr_bob", assigneeTeamId: null });
  });

  it("opened from a team-filtered gantt: defaults to that team (and the task's team follows)", async () => {
    const onCreate = vi.fn(async (_d: TaskDraft) => {});
    renderModal(onCreate, { assigneeId: null, assigneeTeamId: "team_ops" as common.TeamId });
    fireEvent.change(screen.getByTestId("fe4-create-title"), { target: { value: "T" } });
    expect(screen.getByTestId("fe4-create-assignee-trigger")).toHaveTextContent("運営");
    fireEvent.click(screen.getByTestId("fe4-create-submit"));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]![0]).toMatchObject({ assigneeId: null, assigneeTeamId: "team_ops", teamId: "team_ops" });
  });
});

describe("MyTaskCreateModal (タスク発行) — same rule, defaults to the issuer", () => {
  it("defaults the 担当 to the creator and submits it", async () => {
    const onCreate = vi.fn(async (_d: MyTaskDraft) => {});
    render(
      <MyTaskCreateModal
        open
        onClose={() => {}}
        people={USERS}
        teams={TEAMS}
        parentOptions={[]}
        scopeTasks={[]}
        onCreate={onCreate}
        defaultAssignee={{ assigneeId: ME, assigneeTeamId: null }}
      />,
    );
    fireEvent.change(screen.getByTestId("fe4-mytask-create-title"), { target: { value: "T" } });
    expect(screen.getByTestId("fe4-mytask-create-assignee-trigger")).toHaveTextContent("自分");
    fireEvent.click(screen.getByTestId("fe4-mytask-create-submit"));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate.mock.calls[0]![0]).toMatchObject({ assigneeId: ME, assigneeTeamId: null });
  });
});

describe("TaskDetailPanel — a legacy unassigned task", () => {
  const legacy: task.Task = {
    id: "t_legacy" as common.TaskId, eventId: "evt_1", title: "旧タスク", description: null, status: "todo",
    priority: "medium", assigneeId: null, assigneeTeamId: null, teamId: null, startAt: null, dueAt: "2026-09-15T00:00:00.000Z",
    origin: "internal", archivedAt: null, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", version: 1,
  };

  it("still shows, holds edits until a 担当 is chosen, then saves them together", async () => {
    const onSave = vi.fn();
    render(
      <TaskDetailPanel task={legacy} users={USERS} teams={TEAMS} canWrite canDelete onSave={onSave} onDelete={() => {}} onClose={() => {}} autosaveDebounceMs={0} />,
    );
    expect(screen.getByTestId("fe4-detail-assignee-error")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-detail-save-needs-assignee")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("fe4-detail-title"), { target: { value: "変更" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("fe4-detail-assignee-trigger"));
    fireEvent.click(screen.getByTestId("fe4-detail-assignee-option-team:team_dev"));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toMatchObject({ version: 1, title: "変更", assigneeTeamId: "team_dev" });
  });
});
