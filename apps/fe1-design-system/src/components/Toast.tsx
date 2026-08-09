import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ToastKind, ToastOptions } from "../types";
import styles from "./Toast.module.css";
import { cx } from "../utils/cx";
import { Icon } from "./Icon";
import type { IconName } from "../types";

interface ActiveToast extends ToastOptions {
  id: string;
}

interface ToastApi {
  show: (opts: ToastOptions) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const KIND_ICON: Record<ToastKind, IconName> = {
  success: "check-square",
  error: "alert-triangle",
  info: "info",
  warning: "alert-triangle",
};

let counter = 0;

/**
 * Toast host + context. `useToast().show()` is the authoritative contract
 * (凍結案 1-4-3). error toasts stick until dismissed; others auto-dismiss after
 * `durationMs` (default 5000).
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ActiveToast[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const show = useCallback(
    (opts: ToastOptions) => {
      const id = `toast-${++counter}`;
      setToasts((prev) => [...prev, { ...opts, id }]);
      const duration = opts.durationMs ?? 5000;
      // error sticks until closed (test matrix); others auto-dismiss.
      if (opts.kind !== "error" && duration > 0) {
        const timer = setTimeout(() => dismiss(id), duration);
        timers.current.set(id, timer);
      }
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((t) => clearTimeout(t));
      map.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={cx(styles.viewport)} role="region" aria-label="通知">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            className={cx(styles.toast)}
            data-kind={t.kind}
            data-testid={`toast-${t.kind}`}
          >
            <Icon name={KIND_ICON[t.kind]} size="sm" className={styles.icon} />
            <div className={cx(styles.content)}>
              <p className={cx(styles.title)}>{t.title}</p>
              {t.description && <p className={cx(styles.description)}>{t.description}</p>}
            </div>
            <button
              type="button"
              className={cx(styles.close)}
              aria-label="通知を閉じる"
              onClick={() => dismiss(t.id)}
            >
              <Icon name="x" size="sm" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a <ToastProvider>");
  }
  return ctx;
}
