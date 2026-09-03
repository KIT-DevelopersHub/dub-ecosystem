// ThemeToggle — the header control that finally surfaces UiStore.setTheme (theme
// was persisted to localStorage but had no UI, so it sat dead). A 40px icon-only
// Menu (same uniform icon row as the 9-dot / ⚙) whose glyph mirrors the active
// choice — 太陽 (light) / 月 (dark) / モニタ (system) — with a three-way picker.
//
// FE2 owns the theme source of truth (UiStore); AppRoot's ThemeBridge resolves it
// (incl. "system") and drives @dub/ui ThemeProvider, so switching here recolours
// EVERY app via the shared @dub/tokens CSS variables — no per-app wiring.
import { Menu } from "@dub/ui";
import type { IconName, MenuItem } from "@dub/ui";
import { useUiStore, type ThemeValue } from "../store/uiStore.tsx";

// The trigger glyph reflects the CHOICE (not the resolved value): モニタ for
// "system" so the user can see they've delegated to the OS, sun/moon otherwise.
const THEME_ICON: Record<ThemeValue, IconName> = {
  system: "monitor",
  light: "sun",
  dark: "moon",
};

const THEME_LABEL: Record<ThemeValue, string> = {
  system: "システムに合わせる",
  light: "ライト",
  dark: "ダーク",
};

const ORDER: ThemeValue[] = ["system", "light", "dark"];

export function ThemeToggle(): JSX.Element {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);

  const items: MenuItem[] = ORDER.map((value) => {
    const active = value === theme;
    return {
      id: `theme-${value}`,
      // The active choice keeps its own theme glyph but is marked "・使用中"; the
      // Menu has no built-in selected state, so the suffix is the affordance.
      label: active ? `${THEME_LABEL[value]}・使用中` : THEME_LABEL[value],
      icon: THEME_ICON[value],
      onSelect: () => setTheme(value),
      testId: `fe2-theme-option-${value}`,
    };
  });

  return (
    <Menu
      testId="fe2-theme-toggle"
      label={`テーマ: ${THEME_LABEL[theme]}`}
      menuLabel="テーマを切り替え"
      icon={THEME_ICON[theme]}
      align="end"
      iconOnly
      items={items}
    />
  );
}
