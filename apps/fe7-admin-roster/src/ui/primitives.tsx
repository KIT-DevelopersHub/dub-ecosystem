// Minimal FE1 (@dub/ui) stand-ins used to compose FE7 screens. Every part accepts
// `testId?` (frozen 1-7 -> data-testid). Replaced by real @dub/ui in P1.
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import s from "./primitives.module.css";

type TestId = { testId?: string };

export function PageHeader({ title, actions, testId }: { title: string; actions?: ReactNode } & TestId) {
  return (
    <div className={s.pageHeader} data-testid={testId}>
      <h1 className={s.pageTitle}>{title}</h1>
      {actions ? <div>{actions}</div> : null}
    </div>
  );
}

export function Button({
  variant = "default",
  testId,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "danger" } & TestId) {
  const variantClass = variant === "primary" ? s.primary : variant === "danger" ? s.danger : "";
  return <button {...rest} data-testid={testId} className={`${s.button} ${variantClass} ${className ?? ""}`} />;
}

export function TextField({
  label,
  error,
  testId,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label?: string; error?: string } & TestId) {
  return (
    <label className={s.field}>
      {label ? <span className={s.label}>{label}</span> : null}
      <input {...rest} data-testid={testId} className={s.input} />
      {error ? <span className={s.error} role="alert">{error}</span> : null}
    </label>
  );
}

export function Select({
  label,
  error,
  testId,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { label?: string; error?: string } & TestId) {
  return (
    <label className={s.field}>
      {label ? <span className={s.label}>{label}</span> : null}
      <select {...rest} data-testid={testId} className={s.select}>
        {children}
      </select>
      {error ? <span className={s.error} role="alert">{error}</span> : null}
    </label>
  );
}

export type BadgeTone = "neutral" | "success" | "warning" | "danger";
export function Badge({ tone = "neutral", children, testId }: { tone?: BadgeTone; children: ReactNode } & TestId) {
  const cls = { neutral: s.badgeNeutral, success: s.badgeSuccess, warning: s.badgeWarning, danger: s.badgeDanger }[tone];
  return <span className={`${s.badge} ${cls}`} data-testid={testId}>{children}</span>;
}

export function Card({ children, testId }: { children: ReactNode } & TestId) {
  return <div className={s.card} data-testid={testId}>{children}</div>;
}

export function EmptyState({ message, testId }: { message: string } & TestId) {
  return <div className={s.empty} data-testid={testId}>{message}</div>;
}

export function ErrorState({ message, onRetry, testId }: { message: string; onRetry?: () => void } & TestId) {
  return (
    <div className={s.errorState} data-testid={testId}>
      <p>{message}</p>
      {onRetry ? <Button onClick={onRetry} testId={testId ? `${testId}-retry` : undefined}>再試行</Button> : null}
    </div>
  );
}

export function LoadMore({ hasMore, onLoadMore, testId }: { hasMore: boolean; onLoadMore: () => void } & TestId) {
  if (!hasMore) return null;
  return (
    <div className={s.loadMore}>
      <Button onClick={onLoadMore} testId={testId}>さらに読み込む</Button>
    </div>
  );
}

export function Modal({ title, open, onClose, children, testId }: { title: string; open: boolean; onClose: () => void; children: ReactNode } & TestId) {
  if (!open) return null;
  return (
    <div className={s.overlay} onClick={onClose}>
      <div className={s.modal} role="dialog" aria-label={title} data-testid={testId} onClick={(e) => e.stopPropagation()}>
        <h2 className={s.modalTitle}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  open,
  danger,
  confirmLabel = "実行",
  onConfirm,
  onCancel,
  testId,
}: {
  title: string;
  message: ReactNode;
  open: boolean;
  danger?: boolean;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
} & TestId) {
  return (
    <Modal title={title} open={open} onClose={onCancel} testId={testId}>
      <div>{message}</div>
      <div className={s.modalActions}>
        <Button onClick={onCancel} testId={testId ? `${testId}-cancel` : undefined}>キャンセル</Button>
        <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} testId={testId ? `${testId}-confirm` : undefined}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

export function Tabs({ tabs, active, onChange, testId }: { tabs: { id: string; label: string }[]; active: string; onChange: (id: string) => void } & TestId) {
  return (
    <div className={s.tabs} data-testid={testId} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === active}
          className={`${s.tab} ${t.id === active ? s.tabActive : ""}`}
          onClick={() => onChange(t.id)}
          data-testid={testId ? `${testId}-${t.id}` : undefined}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowTestId,
  testId,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  rowTestId?: (row: T) => string;
} & TestId) {
  return (
    <table className={s.table} data-testid={testId}>
      <thead>
        <tr>{columns.map((c) => <th key={c.key}>{c.header}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)} data-testid={rowTestId?.(row)}>
            {columns.map((c) => <td key={c.key}>{c.render(row)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export { s as uiStyles };
