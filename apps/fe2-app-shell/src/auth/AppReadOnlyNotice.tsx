// 「このアプリは閲覧のみ」の共通バナー。
//
// ロール管理でアプリを「閲覧」にすると、書き込みボタンは disabled になる(useAppCapability の
// readOnly フラグ)。ボタンが灰色なだけだと理由が伝わらないので、画面上部に理由を一行出す。
// 「編集」「無効」のときは何も描画しない(無効はそもそもルートガードで開けない)。
//
// 使い方: 書き込み UI を持つ画面の先頭に <AppReadOnlyNotice appId="members" /> を置き、
// 各ボタンに disabled={!canEdit} を付ける。appId は APP_MANIFEST の id。
import { useAppCapability } from "./AuthProvider.tsx";

const style: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--dub-space-2, 8px)",
  padding: "var(--dub-space-3, 12px) var(--dub-space-4, 16px)",
  marginBottom: "var(--dub-space-4, 16px)",
  border: "1px solid var(--dub-color-border-default, #dde1e9)",
  borderRadius: "var(--dub-radius-md, 8px)",
  background: "var(--dub-color-surface-subtle, #f6f8fa)",
  color: "var(--dub-color-text-muted, #57606a)",
  fontSize: 13,
  lineHeight: 1.6,
};

export function AppReadOnlyNotice({ appId, testId }: { appId: string; testId?: string }): JSX.Element | null {
  const { readOnly, label } = useAppCapability(appId);
  if (!readOnly) return null;
  return (
    <div style={style} role="status" data-testid={testId ?? `app-readonly-${appId}`}>
      <span aria-hidden>👁</span>
      <span>
        {label}は<strong>閲覧のみ</strong>の権限です。作成・編集・削除はできません（変更が必要なら管理者に編集権限を依頼してください）。
      </span>
    </div>
  );
}
