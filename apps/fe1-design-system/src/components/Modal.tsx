import { useCallback, useEffect, useRef, useState } from "react";
import type { ConfirmDialogProps, DrawerProps, ModalProps } from "../types";
import styles from "./Modal.module.css";
import { cx } from "../utils/cx";
import { Button, IconButton } from "./Button";

function useEscToClose(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);
}

// Minimal focus trap: keep Tab within the dialog container.
function useFocusTrap(open: boolean, ref: React.RefObject<HTMLElement>) {
  useEffect(() => {
    if (!open || !ref.current) return;
    const container = ref.current;
    const focusable = () =>
      Array.from(
        container.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled"));
    const first = focusable()[0];
    first?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const firstEl = items[0]!;
      const lastEl = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    container.addEventListener("keydown", handler);
    return () => container.removeEventListener("keydown", handler);
  }, [open, ref]);
}

export function Modal({
  open,
  onClose,
  title,
  size = "md",
  footer,
  closeOnOverlayClick = true,
  testId,
  children,
}: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEscToClose(open, onClose);
  useFocusTrap(open, ref);
  if (!open) return null;
  return (
    <div
      className={cx(styles.overlay)}
      onMouseDown={(e) => {
        if (closeOnOverlayClick && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx(styles.dialog)}
        data-size={size}
        data-testid={testId}
      >
        <header className={cx(styles.header)}>
          <h2 className={cx(styles.title)}>{title}</h2>
          <IconButton name="x" aria-label="閉じる" onClick={onClose} />
        </header>
        <div className={cx(styles.body)}>{children}</div>
        {footer && <footer className={cx(styles.footer)}>{footer}</footer>}
      </div>
    </div>
  );
}

/** onConfirm may be async; the confirm button shows loading and blocks re-entry. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "確認",
  cancelLabel = "キャンセル",
  danger,
  onConfirm,
  onCancel,
  testId,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const handleConfirm = useCallback(async () => {
    if (pending) return;
    setPending(true);
    try {
      await onConfirm();
    } finally {
      setPending(false);
    }
  }, [pending, onConfirm]);

  return (
    <Modal open={open} onClose={onCancel} title={title} size="sm" testId={testId}>
      <p className={cx(styles.message)}>{message}</p>
      <div className={cx(styles.confirmActions)}>
        <Button variant="secondary" onClick={onCancel} disabled={pending}>
          {cancelLabel}
        </Button>
        <Button variant={danger ? "danger" : "primary"} loading={pending} onClick={handleConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

export function Drawer({ open, onClose, title, side = "right", testId, children }: DrawerProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEscToClose(open, onClose);
  useFocusTrap(open, ref);
  if (!open) return null;
  return (
    <div
      className={cx(styles.overlay)}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx(styles.drawer)}
        data-side={side}
        data-testid={testId}
      >
        <header className={cx(styles.header)}>
          {title && <h2 className={cx(styles.title)}>{title}</h2>}
          <IconButton name="x" aria-label="閉じる" onClick={onClose} />
        </header>
        <div className={cx(styles.body)}>{children}</div>
      </div>
    </div>
  );
}
