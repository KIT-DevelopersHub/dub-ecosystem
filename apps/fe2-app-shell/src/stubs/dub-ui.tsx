// STUB for @dub/ui (FE1 design system, not yet built). FE2 owns *composition &
// wiring* only; the look of these primitives belongs to FE1. Every prop surface
// here (testId, ToastOptions, DisplayableError, controlled ThemeProvider) mirrors
// the frozen FE1 contract (theme5 1-4) so swapping in the real `@dub/ui` is a
// pure import change. Replace this file when FE1 ships.
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

// ---- shared prop contract (theme5) ---------------------------------------
export interface WithTestId {
  testId?: string; // -> data-testid, e2e canonical <unit>-<screen>-<element>
}

// ---- DisplayableError (FE1 type; api-client bridges ApiError -> this) ------
export interface DisplayableError {
  title: string;
  description: string;
  code?: string;
  requestId?: string; // shown for support correlation
}

// ---- Theme (FE1 ThemeProvider is CONTROLLED: no internal persistence) -------
export type ThemeValue = "light" | "dark" | "system";

export function ThemeProvider({
  theme,
  children,
}: {
  theme: ThemeValue;
  children: ReactNode;
}): JSX.Element {
  return <div data-theme={theme}>{children}</div>;
}

// ---- Toast (type & component owned by FE1; FE2 mounts provider + re-exports) -
export type ToastKind = "success" | "error" | "warning" | "info";
export interface ToastOptions {
  kind: ToastKind;
  title: string;
  description?: string;
}
interface ToastRecord extends ToastOptions {
  id: number;
}

interface ToastApi {
  show(opts: ToastOptions): void;
}
const ToastCtx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const show = useCallback((opts: ToastOptions) => {
    setToasts((prev) => [...prev, { ...opts, id: Date.now() + Math.random() }]);
  }, []);
  const api = useMemo<ToastApi>(() => ({ show }), [show]);
  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div role="region" aria-label="notifications" data-testid="toast-region">
        {toasts.map((t) => (
          <div key={t.id} role="status" data-toast-kind={t.kind}>
            {t.title}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

// ---- Button ---------------------------------------------------------------
export function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
  testId,
  type = "button",
}: WithTestId & {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
}): JSX.Element {
  return (
    <button type={type} data-variant={variant} disabled={disabled} onClick={onClick} data-testid={testId}>
      {children}
    </button>
  );
}

// ---- Layout primitives (FE1 owns the visuals; FE2 composes them) ----------
export function AppShell({
  sidebar,
  header,
  children,
  testId,
}: WithTestId & {
  sidebar: ReactNode;
  header: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div data-component="app-shell" data-testid={testId}>
      {header}
      <div data-region="body">
        {sidebar}
        <main data-region="content">{children}</main>
      </div>
    </div>
  );
}

export function Sidebar({ children, open, testId }: WithTestId & { children: ReactNode; open: boolean }): JSX.Element {
  return (
    <nav data-component="sidebar" data-open={open} aria-label="primary" data-testid={testId}>
      {children}
    </nav>
  );
}

export function PageHeader({
  title,
  actions,
  testId,
}: WithTestId & {
  title: ReactNode;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <header data-component="page-header" data-testid={testId}>
      <div data-slot="title">{title}</div>
      {actions ? <div data-slot="actions">{actions}</div> : null}
    </header>
  );
}
