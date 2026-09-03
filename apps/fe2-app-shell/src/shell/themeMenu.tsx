// themeMenu — builds the 設定(⚙) menu's theme-switch rows. The theme control used to
// be a standalone header icon (ThemeToggle); per user direction it is no longer
// important enough for a permanent header slot, so it now lives INSIDE the settings
// menu as a system/light/dark group.
//
// Behaviour is unchanged, only the location: each row calls UiStore.setTheme, which
// AppRoot's ThemeBridge resolves (incl. "system") and feeds to @dub/ui ThemeProvider,
// so switching recolours EVERY app via the shared @dub/tokens variables and the choice
// persists to localStorage. "system" keeps tracking the OS appearance live.
import type { IconName, MenuItem } from "@dub/ui";
import type { ThemeValue } from "../store/uiStore.tsx";

// The row glyph reflects the CHOICE (not the resolved value): モニタ for "system" so the
// user can see they've delegated to the OS, sun/moon otherwise.
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

// Theme rows for the 設定 menu. `groupDivider` (default true) puts a separator above the
// first row so the theme group is visually set apart from the items before it (e.g.
// アカウント設定); pass false when the group is the menu's first section. The active
// choice keeps its glyph and gains a ・使用中 suffix (Menu has no built-in selected
// state, so the suffix is the affordance — same as the old header picker).
export function buildThemeMenuItems(
  theme: ThemeValue,
  setTheme: (t: ThemeValue) => void,
  groupDivider = true,
): MenuItem[] {
  return ORDER.map((value, i) => {
    const active = value === theme;
    return {
      id: `theme-${value}`,
      label: active ? `${THEME_LABEL[value]}・使用中` : THEME_LABEL[value],
      icon: THEME_ICON[value],
      onSelect: () => setTheme(value),
      testId: `fe2-theme-option-${value}`,
      ...(i === 0 && groupDivider ? { dividerBefore: true } : {}),
    };
  });
}
