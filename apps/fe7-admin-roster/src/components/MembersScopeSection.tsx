// 運営メンバーの詳細設定: アプリの中でどのタブまで届くかを、閲覧・編集それぞれ 3 段で選ぶ。
// 無効 / 閲覧 / 編集 とは別の軸。編集範囲は閲覧範囲を超えられない（policy.setMembersScope が揃える）。
import type { identity } from "@dub/types";
import { policy } from "@dub/types";
import { SegmentedControl } from "@dub/ui";

type Scope = policy.MembersScope;
type Mode = policy.MembersScopeMode;

const blockStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--dub-space-2, 8px)", marginBottom: "var(--dub-space-5, 20px)" };
const headingStyle: React.CSSProperties = { fontWeight: 700, fontSize: 14, margin: 0 };
const hintStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 12.5, lineHeight: 1.6, margin: 0 };

export function MembersScopeSection({
  selected,
  level,
  disabled,
  onChange,
  idPrefix,
}: {
  selected: readonly identity.PermissionKey[];
  level: policy.AppAccessLevel;
  disabled?: boolean;
  onChange: (next: identity.PermissionKey[]) => void;
  idPrefix: string;
}) {
  const appOff = level === policy.AppAccessLevel.None;
  const editOff = level !== policy.AppAccessLevel.Edit;

  const control = (mode: Mode, label: string, locked: boolean) => (
    <SegmentedControl<Scope>
      aria-label={label}
      value={policy.membersScopeOf(selected, mode)}
      onChange={(next) => onChange(policy.setMembersScope(selected, mode, next))}
      options={policy.MEMBERS_SCOPES.map((scope) => ({
        value: scope,
        label: policy.MEMBERS_SCOPE_LABELS[scope],
        disabled: disabled || locked,
        testId: `${idPrefix}-members-scope-${mode}-${scope}`,
      }))}
      testId={`${idPrefix}-members-scope-${mode}`}
    />
  );

  const viewScope = policy.membersScopeOf(selected, "view");
  const editScope = policy.membersScopeOf(selected, "edit");

  return (
    <div data-testid={`${idPrefix}-members-scope`}>
      <div style={blockStyle}>
        <h3 style={headingStyle}>閲覧できる範囲</h3>
        <p style={hintStyle}>
          {appOff ? "このアプリの権限を「閲覧」以上にすると設定できます。" : policy.MEMBERS_SCOPE_DESCRIPTIONS.view[viewScope]}
        </p>
        {control("view", "閲覧できる範囲", appOff)}
      </div>
      <div style={blockStyle}>
        <h3 style={headingStyle}>編集できる範囲</h3>
        {editOff ? (
          <p style={hintStyle} data-testid={`${idPrefix}-members-scope-edit-locked`}>
            このアプリの権限を「編集」にすると設定できます。
          </p>
        ) : (
          <p style={hintStyle}>
            {policy.MEMBERS_SCOPE_DESCRIPTIONS.edit[editScope]}
            {editScope === policy.MembersScope.All
              ? "。メール名簿の編集には、ロール管理の「編集」と「名簿・ロールの管理」も必要です"
              : ""}
            。編集の範囲を広げると、閲覧の範囲も同じだけ広がります。
          </p>
        )}
        {control("edit", "編集できる範囲", editOff)}
      </div>
    </div>
  );
}
