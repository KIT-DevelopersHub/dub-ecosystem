import { useToastStore, type ToastKind } from "../hooks/useToast";

const BG: Record<ToastKind, string> = {
  success: "var(--dub-color-success-600)",
  error: "var(--dub-color-danger-600)",
  info: "var(--dub-color-info-600)",
  warning: "var(--dub-color-warning-600)",
};

// Dev-harness toast surface. In production FE2 owns the toast viewport.
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  return (
    <div style={{ position: "fixed", bottom: 16, right: 16, display: "flex", flexDirection: "column", gap: 8, zIndex: 9999 }} data-testid="fe7-toaster">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          onClick={() => dismiss(t.id)}
          style={{ background: BG[t.kind], color: "#fff", padding: "8px 12px", borderRadius: 8, cursor: "pointer", maxWidth: 320 }}
          data-testid={`fe7-toast-${t.kind}`}
        >
          <strong>{t.title}</strong>
          {t.description ? <div style={{ fontSize: 12 }}>{t.description}</div> : null}
        </div>
      ))}
    </div>
  );
}
