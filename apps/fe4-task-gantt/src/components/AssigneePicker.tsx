// 担当ピッカー (#882): 人とチームを1つの検索つきドロップダウンで選ぶ。直近に選んだ
// 担当（利用者ごと・localStorage）を先頭に出す。TaskFormFields（作成=発行フォーム共通）と
// 詳細パネルの両方がこれを使う。
import { useMemo } from "react";
import type { team } from "@dub/types";
import { SearchableSelect, useRecentSelections, type SearchableSelectOption } from "@dub/ui";
import { decodeAssignee, encodeAssignee, type Assignee, type AssigneeUser } from "../domain/assignee";
import { useTaskRoute } from "../routes/task-route-context";

export interface AssigneePickerProps {
  id: string;
  users: readonly AssigneeUser[];
  teams: readonly Pick<team.Team, "id" | "name">[];
  value: Assignee;
  onChange: (next: Assignee) => void;
  disabled?: boolean;
  /** 担当が空のとき (担当は必須) — red outline + aria-invalid. */
  invalid?: boolean;
  "aria-describedby"?: string;
  testId?: string;
}

export const RECENT_ASSIGNEE_KEY_PREFIX = "fe4.recent-assignees";

export function AssigneePicker({ id, users, teams, value, onChange, disabled, invalid, testId, ...rest }: AssigneePickerProps) {
  const { currentUserId } = useTaskRoute();
  const recent = useRecentSelections(`${RECENT_ASSIGNEE_KEY_PREFIX}.${currentUserId ?? "anon"}`, 5);
  const options = useMemo<SearchableSelectOption[]>(
    // 担当は必須: 「未割当」は選択肢に出さない (空は担当なしの古いタスクだけ・placeholder 表示)。
    () => [
      ...users.map((u) => ({ value: `user:${u.id}`, label: u.displayName, group: "メンバー" })),
      ...teams.map((t) => ({ value: `team:${t.id}`, label: t.name, group: "チーム" })),
    ],
    [users, teams],
  );
  return (
    <SearchableSelect
      id={id}
      value={encodeAssignee(value)}
      options={options}
      pinnedValues={recent.recent}
      pinnedLabel="最近選んだ担当"
      placeholder="担当を選んでください"
      searchPlaceholder="名前・チームで検索"
      emptyText="該当するメンバー・チームがいません"
      disabled={disabled}
      invalid={invalid}
      aria-describedby={rest["aria-describedby"]}
      onChange={(v) => {
        if (!v) return;
        recent.remember(v);
        onChange(decodeAssignee(v));
      }}
      testId={testId}
    />
  );
}
