// ─────────────────────────────────────────────────────────────────────────────
// FE1 design-system contract shim.
//
// FE3 depends on FE1's @dub/ui (Button/Form/Table/Modal/Layout, IconName/Icon,
// ToastOptions, useToast, LoadMore, testId). FE1 is a separate parallel unit and
// is not built yet, so this file provides a minimal, contract-shaped local
// implementation. On integration, delete this file and repoint imports at
// `@dub/ui`. The *shapes* here are the FE3-facing contract and must not drift.
// ─────────────────────────────────────────────────────────────────────────────
import * as React from "react";
import styles from "./fe1.module.css";

// closed union (theme5 1-1-7: `icon: string` is retired in favour of IconName).
export type IconName =
  | "calendar"
  | "plus"
  | "edit"
  | "trash"
  | "archive"
  | "chevron-right"
  | "chevron-down"
  | "chat"
  | "drag"
  | "check"
  | "clock"
  | "user"
  | "flag"
  | "list"
  | "settings"
  | "warning"
  | "task";

export function Icon({ name, size = 16, testId }: { name: IconName; size?: number; testId?: string }) {
  // Placeholder glyph mapping; FE1 ships real SVGs. Kept deterministic for tests.
  const glyph: Record<IconName, string> = {
    calendar: "📅", plus: "＋", edit: "✎", trash: "🗑", archive: "📦",
    "chevron-right": "›", "chevron-down": "⌄", chat: "💬", drag: "⠿",
    check: "✓", clock: "◷", user: "👤", flag: "⚑", list: "≣",
    settings: "⚙", warning: "⚠", task: "☑",
  };
  return (
    <span className={styles.icon} style={{ fontSize: size }} aria-hidden data-icon={name} data-testid={testId}>
      {glyph[name]}
    </span>
  );
}

export interface ToastOptions {
  message: string;
  variant?: "success" | "error" | "info";
  durationMs?: number;
}

export interface ToastApi {
  show: (opts: ToastOptions) => void;
}

const ToastContext = React.createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Array<ToastOptions & { id: number }>>([]);
  const idRef = React.useRef(0);
  const show = React.useCallback((opts: ToastOptions) => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { ...opts, id }]);
    const ttl = opts.durationMs ?? 4000;
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ttl);
  }, []);
  const api = React.useMemo<ToastApi>(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={styles.toastStack} data-testid="fe1-toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={styles.toast} data-variant={t.variant ?? "info"} role="status">
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = React.useContext(ToastContext);
  // Fail-soft: tests that render a component in isolation still get a no-op toast.
  return ctx ?? { show: () => {} };
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  icon?: IconName;
  testId?: string;
};
export function Button({ variant = "secondary", icon, testId, children, className, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={[styles.button, styles[variant], className].filter(Boolean).join(" ")}
      data-testid={testId}
      {...rest}
    >
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

export function Field({
  label,
  error,
  htmlFor,
  children,
}: {
  label: string;
  error?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={styles.field} htmlFor={htmlFor}>
      <span className={styles.fieldLabel}>{label}</span>
      {children}
      {error ? (
        <span className={styles.fieldError} role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  testId?: string;
}) {
  if (!open) return null;
  return (
    <div className={styles.modalOverlay} role="dialog" aria-modal aria-label={title} data-testid={testId}>
      <div className={styles.modal}>
        <div className={styles.modalHeader}>
          <h2>{title}</h2>
          <Button icon="check" variant="ghost" aria-label="close" onClick={onClose} testId="fe1-modal-close">
            ✕
          </Button>
        </div>
        <div className={styles.modalBody}>{children}</div>
      </div>
    </div>
  );
}

export function LoadMore({ hasMore, loading, onClick, testId }: { hasMore: boolean; loading: boolean; onClick: () => void; testId?: string }) {
  if (!hasMore) return null;
  return (
    <Button variant="ghost" onClick={onClick} disabled={loading} testId={testId}>
      {loading ? "読み込み中…" : "さらに読み込む"}
    </Button>
  );
}
