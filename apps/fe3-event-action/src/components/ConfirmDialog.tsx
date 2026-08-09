import { Modal, Button } from "../contracts/fe1";

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

/** Non-optimistic confirmation gate for destructive ops (archive, closed-phase). */
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
    <Modal open={open} onClose={onCancel} title={title} testId={testId}>
      <p>{message}</p>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <Button variant="ghost" onClick={onCancel} testId="fe3-confirm-cancel">
          キャンセル
        </Button>
        <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} testId="fe3-confirm-ok">
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
