// Reusable right-side drawer with a scrim, Esc-to-close and a focus trap (design §6
// a11y). Used by the task composer and the task detail. Renders nothing when closed.
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { t } from "./lib/theme.ts";

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Extra header content (e.g. a phase badge), right-aligned before the close button. */
  headerExtra?: ReactNode;
  /** Element to focus on open (e.g. the composer's first field). Defaults to the panel. */
  initialFocusRef?: RefObject<HTMLElement>;
  testId?: string;
  width?: number;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

export function Drawer({
  open,
  onClose,
  title,
  children,
  headerExtra,
  initialFocusRef,
  testId,
  width = 520,
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Move focus into the panel on open so keyboard + screen-reader users land inside the
  // dialog (and the Tab trap has somewhere to start).
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const target = initialFocusRef?.current ?? panel.querySelector<HTMLElement>(FOCUSABLE) ?? panel;
      target.focus();
    }, 0);
    return () => clearTimeout(id);
  }, [open, initialFocusRef]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "Tab" && panelRef.current) {
        const nodes = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
        if (nodes.length === 0) return;
        const first = nodes[0]!;
        const last = nodes[nodes.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      data-testid={testId ? `${testId}-scrim` : undefined}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        zIndex: 50,
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        data-testid={testId}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: `min(${width}px, 100%)`,
          height: "100%",
          background: t.bg,
          borderLeft: `1px solid ${t.border}`,
          boxShadow: "var(--dub-shadow-overlay, -8px 0 32px rgba(0,0,0,0.4))",
          padding: t.space6,
          overflowY: "auto",
          boxSizing: "border-box",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: t.space3,
            marginBottom: t.space5,
          }}
        >
          <h2 style={{ fontSize: 16, margin: 0, flex: 1 }}>{title}</h2>
          {headerExtra}
          <button
            type="button"
            aria-label="閉じる"
            data-testid={testId ? `${testId}-close` : undefined}
            onClick={onClose}
            style={{
              border: `1px solid ${t.border}`,
              background: "transparent",
              color: "inherit",
              borderRadius: "var(--dub-radius-sm, 8px)",
              width: 32,
              height: 32,
              cursor: "pointer",
              fontSize: 16,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
