import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { common, team } from "@dub/types";
import { MyTaskCreateModal, type MyTaskDraft } from "../src/components/MyTaskCreateModal";
import type { ScopeTask } from "../src/domain/task-hierarchy";

// ③ 新規タスク作成（マイタスク／ガント共通の MyTaskCreateModal）で 先行タスク・親タスク を
// 設定できる。共通コンポーネントに寄せてあるので、この1つのモーダルのテストが両方をカバーする。
//   - scopeTasks（対象イベントのタスク候補）があるとき、親タスク検索＋先行タスクピッカーを出す。
//   - 親を選ぶ（プリセット含む）とチームは親のチームに固定される（親子で同一チーム）。
//   - submit の draft に parentId / dependsOnIds が載る。
//   - scopeTasks が無い場面（イベント未確定の発行など）では関係欄を出さない。

const TEAMS: team.Team[] = [
  { id: "team_dev" as common.TeamId, key: "dev", name: "開発チーム" },
  { id: "team_hq" as common.TeamId, key: "hq", name: "統括チーム" },
];

const SCOPE: ScopeTask[] = [
  { id: "tk_a" as common.TaskId, title: "設計を固める", parentTaskId: null, teamId: "team_dev" as common.TeamId },
  { id: "tk_b" as common.TaskId, title: "実装する", parentTaskId: null, teamId: "team_dev" as common.TeamId },
  { id: "tk_c" as common.TaskId, title: "別チームの作業", parentTaskId: null, teamId: "team_hq" as common.TeamId },
];

const EVENT_ID = "evt_1" as common.EventId;

describe("③ 作成モーダル: 先行タスク・親タスクを設定できる（マイタスク／ガント共通）", () => {
  it("scopeTasks があると 親タスク検索・先行タスクピッカー を表示する", () => {
    render(
      <MyTaskCreateModal
        open
        onClose={() => {}}
        events={[]}
        people={[]}
        teams={TEAMS}
        onCreate={async () => {}}
        scopeTasks={SCOPE}
        scopeEventId={EVENT_ID}
        defaultEventId={EVENT_ID}
        lockEventToDefault
      />,
    );
    expect(screen.getByTestId("fe4-mytask-create-parent")).toBeTruthy();
    expect(screen.getByTestId("fe4-mytask-create-deps")).toBeTruthy();
  });

  it("scopeTasks が無い場面では関係欄を出さない", () => {
    render(
      <MyTaskCreateModal
        open
        onClose={() => {}}
        events={[]}
        people={[]}
        teams={TEAMS}
        onCreate={async () => {}}
        lockEventToDefault
        defaultEventId={EVENT_ID}
      />,
    );
    expect(screen.queryByTestId("fe4-mytask-create-parent")).toBeNull();
    expect(screen.queryByTestId("fe4-mytask-create-deps")).toBeNull();
  });

  it("親をプリセットするとチームが親（開発チーム）に固定され、submit の draft に parentId が載る", async () => {
    const onCreate = vi.fn(async (_d: MyTaskDraft) => {});
    render(
      <MyTaskCreateModal
        open
        onClose={() => {}}
        events={[]}
        people={[]}
        teams={TEAMS}
        onCreate={onCreate}
        scopeTasks={SCOPE}
        scopeEventId={EVENT_ID}
        defaultEventId={EVENT_ID}
        lockEventToDefault
        initialParentId={"tk_a" as common.TaskId}
      />,
    );
    // チームは親（tk_a=開発チーム）に固定＝変更不可。
    const teamSelect = screen.getByTestId("fe4-mytask-create-team") as HTMLSelectElement;
    expect(teamSelect.value).toBe("team_dev");
    expect(teamSelect.disabled).toBe(true);
    expect(screen.getByTestId("fe4-mytask-create-team-locked")).toBeTruthy();

    fireEvent.change(screen.getByTestId("fe4-mytask-create-title"), { target: { value: "子タスク" } });
    fireEvent.click(screen.getByTestId("fe4-mytask-create-submit"));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    const draft = onCreate.mock.calls[0]![0];
    expect(draft.parentId).toBe("tk_a");
    expect(draft.teamId).toBe("team_dev");
  });

  it("先行タスクをプリセットすると submit の draft に dependsOnIds が載る", async () => {
    const onCreate = vi.fn(async (_d: MyTaskDraft) => {});
    render(
      <MyTaskCreateModal
        open
        onClose={() => {}}
        events={[]}
        people={[]}
        teams={TEAMS}
        onCreate={onCreate}
        scopeTasks={SCOPE}
        scopeEventId={EVENT_ID}
        defaultEventId={EVENT_ID}
        lockEventToDefault
        initialDependsOn={["tk_a" as common.TaskId]}
      />,
    );
    fireEvent.change(screen.getByTestId("fe4-mytask-create-title"), { target: { value: "後続タスク" } });
    fireEvent.click(screen.getByTestId("fe4-mytask-create-submit"));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    const draft = onCreate.mock.calls[0]![0];
    expect(draft.dependsOnIds).toEqual(["tk_a"]);
  });
});
