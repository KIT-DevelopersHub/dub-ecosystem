import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ConfirmDialogProps, DrawerProps, ErrorDialogProps, ModalProps } from "../types";
import styles from "./Modal.module.css";
import { cx } from "../utils/cx";
import { Button, IconButton } from "./Button";
import { Icon } from "./Icon";

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

// Ref-counted scroll lock so nested/stacked overlays don't fight over body.style,
// and the original overflow is restored only once every overlay has closed.
let scrollLockCount = 0;
let savedBodyOverflow = "";
function useScrollLock(open: boolean) {
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    if (scrollLockCount === 0) {
      savedBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    scrollLockCount += 1;
    return () => {
      scrollLockCount -= 1;
      if (scrollLockCount === 0) document.body.style.overflow = savedBodyOverflow;
    };
  }, [open]);
}

// Restore focus to the element that was focused before the overlay opened, so
// keyboard users return to their place in the page after closing.
function useFocusRestore(open: boolean) {
  const previouslyFocused = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    return () => previouslyFocused.current?.focus?.();
  }, [open]);
}

// Render overlays at <body> via a portal so `position: fixed` is measured against
// the viewport and the overlay escapes any ancestor stacking context / overflow clip.
function OverlayPortal({ children }: { children: React.ReactNode }) {
  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}

// A real, typeable field — the thing a user opening a dialog actually wants focused,
// as opposed to a header's close button or a footer's submit button. Excludes hidden/
// disabled/readonly/non-typing input types so e.g. a hidden CSRF field never "wins".
const MEANINGFUL_INPUT_SELECTOR =
  'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([disabled]):not([readonly]), ' +
  "textarea:not([disabled]):not([readonly]), " +
  "select:not([disabled]), " +
  '[contenteditable="true"]';

// Initial focus on open: prefer the first meaningful input field inside the dialog BODY
// (so opening e.g. a task-create modal drops the caret straight into 「タイトル」), and
// only fall back to the first focusable element overall (header close button etc.) when
// the body has no input — e.g. ConfirmDialog, which is button-only and should keep the
// previous "focus the first focusable thing" behavior.
function useInitialFocus(
  open: boolean,
  containerRef: React.RefObject<HTMLElement>,
  bodyRef: React.RefObject<HTMLElement>,
) {
  useEffect(() => {
    if (!open || !containerRef.current) return;
    const container = containerRef.current;
    const body = bodyRef.current;
    const meaningfulField = body?.querySelector<HTMLElement>(MEANINGFUL_INPUT_SELECTOR);
    if (meaningfulField) {
      meaningfulField.focus();
      return;
    }
    const firstFocusable = container.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    const first = Array.from(firstFocusable).find((el) => !el.hasAttribute("disabled"));
    first?.focus();
  }, [open, containerRef, bodyRef]);
}

// Minimal focus trap: keep Tab within the dialog container. Initial focus placement is
// handled separately by useInitialFocus so it can prioritize meaningful input fields.
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
  const bodyRef = useRef<HTMLDivElement>(null);
  useEscToClose(open, onClose);
  useFocusTrap(open, ref);
  useInitialFocus(open, ref, bodyRef);
  useScrollLock(open);
  useFocusRestore(open);
  if (!open) return null;
  return (
    <OverlayPortal>
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
          <div ref={bodyRef} className={cx(styles.body)}>{children}</div>
          {footer && <footer className={cx(styles.footer)}>{footer}</footer>}
        </div>
      </div>
    </OverlayPortal>
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

/**
 * Blocking error dialog — the loud counterpart to an inline field error. Surfaces
 * a failed action's REASON so it can never be silently swallowed. Reusable: feed
 * any DisplayableError, optionally a validation breakdown + a retry.
 */
export function ErrorDialog({
  open,
  title = "処理できませんでした",
  error,
  details,
  hint,
  onClose,
  closeLabel = "閉じる",
  onRetry,
  retryLabel = "再試行",
  testId,
}: ErrorDialogProps) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm" testId={testId} closeOnOverlayClick={false}>
      <div className={cx(styles.errorBody)} role="alert" data-error-code={error.code}>
        <span className={cx(styles.errorIcon)} aria-hidden>
          <Icon name={error.code === "FORBIDDEN" ? "shield" : "alert-triangle"} size="lg" />
        </span>
        <div className={cx(styles.errorContent)}>
          <p className={cx(styles.errorMessage)} data-testid={testId ? `${testId}-message` : undefined}>
            {error.message}
          </p>
          {details && details.length > 0 && (
            <ul className={cx(styles.errorDetails)} data-testid={testId ? `${testId}-details` : undefined}>
              {details.map((d, i) => (
                <li key={i} className={cx(styles.errorDetailItem)}>
                  {d.label && <span className={cx(styles.errorDetailLabel)}>{d.label}</span>}
                  <span>{d.message}</span>
                </li>
              ))}
            </ul>
          )}
          {hint && <p className={cx(styles.errorHint)}>{hint}</p>}
          {error.correlationId && (
            <p className={cx(styles.errorCorrelation)}>エラーID: {error.correlationId}</p>
          )}
        </div>
      </div>
      <div className={cx(styles.confirmActions)}>
        {onRetry && (
          <Button variant="secondary" onClick={onRetry} testId={testId ? `${testId}-retry` : undefined}>
            {retryLabel}
          </Button>
        )}
        <Button variant="primary" onClick={onClose} testId={testId ? `${testId}-close` : undefined}>
          {closeLabel}
        </Button>
      </div>
    </Modal>
  );
}

export function Drawer({ open, onClose, title, side = "right", testId, children }: DrawerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEscToClose(open, onClose);
  useFocusTrap(open, ref);
  useInitialFocus(open, ref, bodyRef);
  useScrollLock(open);
  useFocusRestore(open);
  if (!open) return null;
  return (
    <OverlayPortal>
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
          <div ref={bodyRef} className={cx(styles.body)}>{children}</div>
        </div>
      </div>
    </OverlayPortal>
  );
}
