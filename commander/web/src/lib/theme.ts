// Shared style tokens for the Commander board. Values reference @dub/tokens CSS vars
// (--dub-*, injected by main.tsx / the fe2 shell) with literal fallbacks so the UI is
// never unstyled when the token sheet is absent (e.g. jsdom tests). Centralised so
// spacing/colour stay consistent (ui-spacing-principle) instead of scattered inline.
import type { CSSProperties } from "react";

export const t = {
  // spacing scale (design §6: generous, never cramped)
  space1: "var(--dub-space-1, 4px)",
  space2: "var(--dub-space-2, 8px)",
  space3: "var(--dub-space-3, 12px)",
  space4: "var(--dub-space-4, 16px)",
  space5: "var(--dub-space-5, 20px)",
  space6: "var(--dub-space-6, 24px)",
  // surfaces / text / borders
  bg: "var(--dub-color-surface-base, #0f1115)",
  surface: "var(--dub-color-surface-raised, #1a1e27)",
  sunken: "var(--dub-color-surface-sunken, #12151c)",
  overlay: "var(--dub-color-surface-overlay, #1c2029)",
  text: "var(--dub-color-text-primary, #e6e6e6)",
  textMuted: "var(--dub-color-text-muted, #9aa4b6)",
  border: "var(--dub-color-border-default, #2a2f3a)",
  borderStrong: "var(--dub-color-border-strong, #3f4759)",
  primary: "var(--dub-color-brand-500, #3358e8)",
  danger: "var(--dub-color-danger-500, #e5484d)",
  warning: "var(--dub-color-warning-600, #b45309)",
  success: "var(--dub-color-success-500, #30a46c)",
  radius: "var(--dub-radius-md, 10px)",
} as const;

export const card: CSSProperties = {
  background: t.surface,
  border: `1px solid ${t.border}`,
  borderRadius: t.radius,
  padding: t.space4,
};

export const btnBase: CSSProperties = {
  padding: `${t.space2} ${t.space4}`,
  borderRadius: "var(--dub-radius-sm, 8px)",
  border: 0,
  fontWeight: 600,
  fontSize: 13,
  cursor: "pointer",
  fontFamily: "inherit",
};

export const btnPrimary: CSSProperties = { ...btnBase, background: t.primary, color: "#fff" };

export const btnGhost: CSSProperties = {
  ...btnBase,
  background: "transparent",
  border: `1px solid ${t.border}`,
  color: "inherit",
};

export const btnDanger: CSSProperties = { ...btnBase, background: t.danger, color: "#fff" };

export const input: CSSProperties = {
  padding: `${t.space2} ${t.space3}`,
  borderRadius: "var(--dub-radius-sm, 8px)",
  border: `1px solid ${t.border}`,
  background: t.sunken,
  color: "inherit",
  font: "inherit",
  boxSizing: "border-box",
  width: "100%",
};
