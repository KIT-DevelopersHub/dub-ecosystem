import { ConfirmDialog as UiConfirmDialog } from "@dub/ui";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
  testId?: string;
}

/**
 * Non-optimistic confirmation gate for destructive ops (archive, closed-phase).
 * Thin wrapper over the @dub/ui core `ConfirmDialog` so every confirm gate in the
 * ecosystem shares one look/behaviour (scrim, focus trap, Esc, styled action row).
 * Keeps fe3's destructive-by-default semantics (`danger`, 実行) so call sites are
 * unchanged. Do not hand-roll a Modal + buttons here — use the core component.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "実行",
  onConfirm,
  onCancel,
  danger = true,
  testId,
}: ConfirmDialogProps) {
  return (
    <UiConfirmDialog
      open={open}
      title={title}
      message={message}
      confirmLabel={confirmLabel}
      danger={danger}
      onConfirm={onConfirm}
      onCancel={onCancel}
      testId={testId}
    />
  );
}
