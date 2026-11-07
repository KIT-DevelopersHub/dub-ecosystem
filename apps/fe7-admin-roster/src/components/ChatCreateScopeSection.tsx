// チャットの詳細設定: 何を作成できるかを 3 択で選ぶ。効くのは 3 段階が「編集」のときだけ
//（サーバの表が app:chat:edit も要求する）なので、それ以外では理由を出して触れなくする。
import type { identity } from "@dub/types";
import { policy } from "@dub/types";
import { SegmentedControl } from "@dub/ui";

const blockStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--dub-space-2, 8px)", marginBottom: "var(--dub-space-5, 20px)" };
const headingStyle: React.CSSProperties = { fontWeight: 700, fontSize: 14, margin: 0 };
const hintStyle: React.CSSProperties = { color: "var(--dub-color-text-muted, #6f7a90)", fontSize: 12.5, lineHeight: 1.6, margin: 0 };

export function ChatCreateScopeSection({
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
  const editOff = level !== policy.AppAccessLevel.Edit;
  const scope = policy.chatCreateScopeOf(selected);

  return (
    <div style={blockStyle} data-testid={`${idPrefix}-chat-create-scope`}>
      <h3 style={headingStyle}>作成できるチャンネル</h3>
      {editOff ? (
        <p style={hintStyle} data-testid={`${idPrefix}-chat-create-scope-locked`}>
          このアプリの権限を「編集」にすると設定できます。
        </p>
      ) : (
        <p style={hintStyle}>{policy.CHAT_CREATE_SCOPE_DESCRIPTIONS[scope]}</p>
      )}
      <SegmentedControl<policy.ChatCreateScope>
        aria-label="作成できるチャンネル"
        value={scope}
        onChange={(next) => onChange(policy.setChatCreateScope(selected, next))}
        options={policy.CHAT_CREATE_SCOPES.map((value) => ({
          value,
          label: policy.CHAT_CREATE_SCOPE_LABELS[value],
          disabled: disabled || editOff,
          testId: `${idPrefix}-chat-create-scope-${value}`,
        }))}
        testId={`${idPrefix}-chat-create-scope-control`}
      />
    </div>
  );
}
