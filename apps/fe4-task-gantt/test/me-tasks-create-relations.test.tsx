import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { common, team } from "@dub/types";
import { MyTaskCreateModal, type MyTaskDraft, type EventOption } from "../src/components/MyTaskCreateModal";
import type { ScopeTask } from "../src/domain/task-hierarchy";

// ③ マイタスク「タスクを発行」でも、ガント（TaskCreateModal）と同じく 親タスク・先行タスクを
// 設定できる。関係欄は「選択中の対象イベント」が候補(scopeTasks)の属するイベント(scopeEventId)と
// 一致するときだけ出す（別イベントの親子・依存を作らせない）。親を選ぶとチームは親に固定される。

const EVT = "evt_conf" as common.EventId;
const OTHER = "evt_other" as common.EventId;
const TM_DEV = "team_dev" as common.TeamId;

const EVENTS: readonly EventOption[] = [
  { id: EVT, name: "北陸ITカンファレンス2026" },
  { id: OTHER, name: "別イベント" },
];

const TEAMS: team.Team[] = [
  { id: "team_hq" as common.TeamId, key: "hq", name: "統括チーム" },
  { id: TM_DEV, key: "dev", name: "開発チーム" },
];

// 候補は EVT の（トップレベル）タスク2件・同一チーム。
const SCOPE: ScopeTask[] = [
  { id: "t1" as common.TaskId, title: "会場設営", parentTaskId: null, teamId: TM_DEV },
  { id: "t2" as common.TaskId, title: "受付準備", parentTaskId: null, teamId: TM_DEV },
];

function renderModal(overrides: Partial<React.ComponentProps<typeof MyTaskCreateModal>> = {}) {
  const onCreate = vi.fn(async (_d: MyTaskDraft) => {});
  render(
    <MyTaskCreateModal
      open
      onClose={() => {}}
      events={EVENTS}
      people={[]}
      teams={TEAMS}
      onCreate={onCreate}
      scopeTasks={SCOPE}
      scopeEventId={EVT}
      {...overrides}
    />,
  );
  return { onCreate };
}

describe("③ マイタスク発行モーダル: 先行/親タスクを設定できる", () => {
  it("対象イベント未選択のあいだは 親/先行 欄を出さない", () => {
    renderModal();
    // 既定は「紐付けない」。scope はあってもイベント未確定なので関係欄は出さない。
    expect(screen.queryByTestId("fe4-mytask-create-parent-input")).toBeNull();
    expect(screen.queryByTestId("fe4-mytask-create-deps-input")).toBeNull();
  });

  it("候補と一致する対象イベントを選ぶと 親/先行 欄が現れる", () => {
    renderModal();
    fireEvent.change(screen.getByTestId("fe4-mytask-create-event"), { target: { value: EVT } });
    expect(screen.getByTestId("fe4-mytask-create-parent-input")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-mytask-create-deps-input")).toBeInTheDocument();
  });

  it("別イベント（候補の属さないイベント）を選んでも関係欄は出さない（別イベントの親子・依存を作らせない）", () => {
    renderModal();
    fireEvent.change(screen.getByTestId("fe4-mytask-create-event"), { target: { value: OTHER } });
    expect(screen.queryByTestId("fe4-mytask-create-parent-input")).toBeNull();
    expect(screen.queryByTestId("fe4-mytask-create-deps-input")).toBeNull();
  });

  it("親タスクを選ぶとチームは親のチームに固定され、submit の draft.parentId に反映される", async () => {
    const { onCreate } = renderModal();
    fireEvent.change(screen.getByTestId("fe4-mytask-create-event"), { target: { value: EVT } });
    // 親タスク t1 を検索セレクトから選ぶ。
    fireEvent.focus(screen.getByTestId("fe4-mytask-create-parent-input"));
    fireEvent.mouseDown(screen.getByTestId("fe4-mytask-create-parent-opt-t1"));
    // チーム欄は親のチーム（開発チーム）で固定・変更不可＋注記。
    const teamSelect = screen.getByTestId("fe4-mytask-create-team") as HTMLSelectElement;
    expect(teamSelect.value).toBe(TM_DEV);
    expect(teamSelect.disabled).toBe(true);
    expect(screen.getByTestId("fe4-mytask-create-team-locked")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("fe4-mytask-create-title"), { target: { value: "配線チェック" } });
    fireEvent.click(screen.getByTestId("fe4-mytask-create-submit"));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    const draft = onCreate.mock.calls[0]![0];
    expect(draft.parentId).toBe("t1");
    expect(draft.teamId).toBe(TM_DEV);
  });

  it("トップレベル新規タスクは（チームを選べば）先行タスクを設定でき、submit の draft.dependsOnIds に反映される", async () => {
    const { onCreate } = renderModal();
    fireEvent.change(screen.getByTestId("fe4-mytask-create-event"), { target: { value: EVT } });
    // 親なし（トップレベル）。依存は同一チームのみ（ADR-0007）なので、まずチームを開発チームに合わせる。
    fireEvent.change(screen.getByTestId("fe4-mytask-create-team"), { target: { value: TM_DEV } });
    // これで先行候補は同一チーム(開発)の t1/t2。検索欄に入力して t2「受付準備」を先行に追加。
    const depsInput = screen.getByTestId("fe4-mytask-create-deps-input");
    fireEvent.focus(depsInput);
    fireEvent.change(depsInput, { target: { value: "受付" } });
    fireEvent.mouseDown(screen.getByTestId("fe4-mytask-create-deps-opt-t2"));

    fireEvent.change(screen.getByTestId("fe4-mytask-create-title"), { target: { value: "撤収" } });
    fireEvent.click(screen.getByTestId("fe4-mytask-create-submit"));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    const draft = onCreate.mock.calls[0]![0];
    expect(draft.parentId).toBeNull();
    expect(draft.teamId).toBe(TM_DEV);
    expect(draft.dependsOnIds).toContain("t2");
  });
});
