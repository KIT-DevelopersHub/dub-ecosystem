import { describe, it, expect, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders as render } from "./helpers-providers";
import type { identity, team } from "@dub/types";
import { TaskCreateModal } from "../src/components/TaskCreateModal";
import { MyTaskCreateModal } from "../src/components/MyTaskCreateModal";
import type { ScopeTask } from "../src/domain/task-hierarchy";

// ユーザー確定レイアウト（両フォーム共通・共通コンポーネント TaskFormFields）:
//   タイトル                （全幅）
//   ステータス   優先度      （2カラム・同一行）
//   担当         チーム      （2カラム・同一行）
//   開始日       終了日      （2カラム・同一行）
//   親タスク                （全幅）
//   先行タスク              （全幅）
//   詳細                    （全幅）
// この並び・2カラム対を回帰テストで固定する（何度も崩れた指摘の再発防止）。

beforeEach(() => localStorage.clear());

const TEAMS: team.Team[] = [
  { id: "A", key: "a", name: "チームA" },
  { id: "B", key: "b", name: "チームB" },
];
const SCOPE: ScopeTask[] = [
  { id: "P", title: "親P", parentTaskId: null, teamId: "A" },
  { id: "c1", title: "子1", parentTaskId: "P", teamId: "A" },
];
const PARENT_OPTS = SCOPE.map((s) => ({ id: s.id, title: s.title }));
const USERS: identity.UserSummary[] = [{ id: "u1", displayName: "山田" } as identity.UserSummary];

/** the `.formRow` (2-column pair) that owns a field, identified by its testId. CSS-module
 *  class names keep the local name as a substring, so `[class*="formRow"]` is stable. */
function rowOf(testId: string): Element {
  const el = screen.getByTestId(testId).closest('[class*="formRow"]');
  expect(el, `${testId} must live inside a .formRow`).not.toBeNull();
  return el as Element;
}
/** true iff node `a` appears before node `b` in document order. */
function precedes(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/** Assert the shared spec: the three 2-column pairs, their order, 詳細 present, and no
 *  legacy 期日/期限 wording. `prefix` = the form's testId prefix. */
function assertSpecLayout(prefix: string) {
  // 2カラム対は同一 .formRow（＝同一行・空セルなしで横並び）
  expect(rowOf(`${prefix}-status`)).toBe(rowOf(`${prefix}-priority`));
  expect(rowOf(`${prefix}-assignee`)).toBe(rowOf(`${prefix}-team`));
  expect(rowOf(`${prefix}-start`)).toBe(rowOf(`${prefix}-due`));

  // 3対の縦の並び順: ステータス行 → 担当行 → 日付行
  expect(precedes(rowOf(`${prefix}-status`), rowOf(`${prefix}-assignee`))).toBe(true);
  expect(precedes(rowOf(`${prefix}-assignee`), rowOf(`${prefix}-start`))).toBe(true);

  // 全幅フィールドの並び: 日付行 → 親タスク → 先行タスク → 詳細
  const dateRow = rowOf(`${prefix}-start`);
  const parent = screen.getByTestId(`${prefix}-parent`);
  const deps = screen.getByTestId(`${prefix}-deps-input`);
  const desc = screen.getByTestId(`${prefix}-desc`);
  expect(precedes(dateRow, parent)).toBe(true);
  expect(precedes(parent, deps)).toBe(true);
  expect(precedes(deps, desc)).toBe(true);

  // 「期日」「期限」表記は「終了日」に統一されている
  expect(screen.getByTestId(`${prefix}-modal`)).not.toHaveTextContent("期日");
  expect(screen.getByTestId(`${prefix}-modal`)).not.toHaveTextContent("期限");
  expect(screen.getByTestId(`${prefix}-modal`)).toHaveTextContent("終了日");
}

describe("タスク作成フォームの確定レイアウト（両フォーム共通）", () => {
  it("ガント作成 (TaskCreateModal) が仕様どおりの並び・2カラム対になっている", () => {
    render(
      <TaskCreateModal
        open
        onClose={() => {}}
        users={USERS}
        teams={TEAMS}
        parentOptions={PARENT_OPTS}
        scopeTasks={SCOPE}
        onCreate={async () => {}}
      />,
    );
    assertSpecLayout("fe4-create");
  });

  it("タスク発行 (MyTaskCreateModal) も同じ並び・2カラム対に統一されている", () => {
    render(
      <MyTaskCreateModal
        open
        onClose={() => {}}
        events={[]}
        people={USERS}
        teams={TEAMS}
        parentOptions={PARENT_OPTS}
        scopeTasks={SCOPE}
        onCreate={async () => {}}
      />,
    );
    assertSpecLayout("fe4-mytask-create");
  });
});
