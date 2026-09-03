// Color / display settings (カラー設定). Opened from 設定(⚙) → カラー設定 as a single menu
// entry, this dialog is where the viewer configures their appearance preferences. Today
// it holds the theme picker (system/light/dark); it is deliberately structured as a
// sectioned 表示設定 surface so future display options (density, accent, etc.) slot in
// beside テーマ without another menu item.
//
// The theme control moved OUT of the ⚙ menu (system/light/dark rows were odd sitting
// directly in the settings dropdown, per user direction). Behaviour is unchanged: the
// SegmentedControl drives UiStore.setTheme, which AppRoot's ThemeBridge resolves (incl.
// "system") and feeds to @dub/ui ThemeProvider — so every app recolours via the shared
// @dub/tokens variables, the choice persists to localStorage, and "system" keeps
// tracking the OS appearance live. Selection is applied immediately (a live preview);
// there is no separate 保存 step, so the footer only offers 閉じる.
import { Modal, Button, SegmentedControl } from "@dub/ui";
import type { IconName, SegmentedOption } from "@dub/ui";
import { useUiStore, type ThemeValue } from "../store/uiStore.tsx";

// Icon per choice reflects the CHOICE (not the resolved value): monitor for "system" so
// the viewer sees they've delegated to the OS, sun/moon for the explicit modes.
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

const THEME_HINT: Record<ThemeValue, string> = {
  system: "OSの外観設定に自動で追従します。",
  light: "明るい配色で固定します。",
  dark: "暗い配色で固定します。",
};

const THEME_ORDER: ThemeValue[] = ["system", "light", "dark"];

const THEME_OPTIONS: SegmentedOption<ThemeValue>[] = THEME_ORDER.map((value) => ({
  value,
  label: THEME_LABEL[value],
  icon: THEME_ICON[value],
  testId: `fe2-theme-option-${value}`,
}));

export function ColorSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="カラー設定"
      size="sm"
      testId="fe2-color-settings"
      footer={
        <Button variant="primary" onClick={onClose} testId="fe2-color-settings-close">
          閉じる
        </Button>
      }
    >
      <div className="fe2-color-form">
        <section className="fe2-color-section" data-testid="fe2-color-theme-section">
          <div className="fe2-color-section-head">
            <div className="fe2-color-section-title">テーマ</div>
            <div className="fe2-color-section-help">
              画面全体の配色を選びます。選ぶとすぐに反映され、次回以降も保持されます。
            </div>
          </div>
          <SegmentedControl<ThemeValue>
            options={THEME_OPTIONS}
            value={theme}
            onChange={setTheme}
            aria-label="テーマ"
            testId="fe2-color-theme-segmented"
          />
          <p className="fe2-color-current" data-testid="fe2-color-theme-current">
            現在の設定：<strong>{THEME_LABEL[theme]}</strong> — {THEME_HINT[theme]}
          </p>
        </section>
      </div>
    </Modal>
  );
}
