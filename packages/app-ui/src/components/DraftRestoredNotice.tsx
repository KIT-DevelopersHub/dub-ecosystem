// DraftRestoredNotice — the "下書きを復元しました" banner shown when useDraftAutosave
// found a saved draft and the caller seeded its fields from it. Layer ② composite:
// pure presentation (@dub/ui Button only), state is owned by the caller/hook. Renders
// nothing when not visible, so a form can mount it unconditionally.
import { Button } from "@dub/ui";

export interface DraftRestoredNoticeProps {
  /** Whether the notice is shown (typically DraftAutosave.restoredVisible). */
  visible: boolean;
  /** Discard the restored draft and reset the form to its pristine state. */
  onDiscard: () => void;
  /** Keep the draft, just hide the notice (typically acknowledgeRestored). */
  onKeep: () => void;
  /** Override copy (default: 未送信の下書きを復元しました。). */
  message?: string;
  testId?: string;
}

const box: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid var(--dub-color-border, #d0d7de)",
  background: "var(--dub-color-bg-subtle, #f6f8fa)",
  color: "var(--dub-color-fg, #1f2328)",
  fontSize: 13,
};
const actions: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };

export function DraftRestoredNotice({
  visible,
  onDiscard,
  onKeep,
  message = "未送信の下書きを復元しました。",
  testId,
}: DraftRestoredNoticeProps): JSX.Element | null {
  if (!visible) return null;
  return (
    <div style={box} role="status" aria-live="polite" data-testid={testId}>
      <span>{message}</span>
      <span style={actions}>
        <Button variant="ghost" onClick={onDiscard} testId={testId ? `${testId}-discard` : undefined}>
          破棄
        </Button>
        <Button variant="ghost" onClick={onKeep} testId={testId ? `${testId}-keep` : undefined}>
          閉じる
        </Button>
      </span>
    </div>
  );
}
