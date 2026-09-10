// Color / display settings (カラー設定). Opened from 設定(⚙) → カラー設定 as a single menu
// entry, this dialog is where the viewer configures their appearance preferences. Today
// it holds the theme picker (system/light/dark); it is deliberately structured as a
// sectioned 表示設定 surface so future display options (density, accent, etc.) slot in
// beside テーマ without another menu item.
//
// The theme control moved OUT of the ⚙ menu (system/light/dark rows were odd sitting
// directly in the settings dropdown, per user direction). Behaviour is unchanged: each
// option drives UiStore.setTheme, which AppRoot's ThemeBridge resolves (incl. "system")
// and feeds to @dub/ui ThemeProvider — so every app recolours via the shared @dub/tokens
// variables, the choice persists to localStorage, and "system" keeps tracking the OS
// appearance live. Selection is applied immediately (a live preview); there is no
// separate 保存 step, so the footer only offers 閉じる.
//
// Layout: the three choices render as a VERTICAL radiogroup (icon + label + hint per
// row, check on the selected one) rather than a horizontal segmented strip. The full
// Japanese labels ("システムに合わせる" etc.) are wide, so a 3-up strip wrapped into an
// ugly two-row grid inside the narrow (size="sm") modal. A stacked list is
// width-independent — it always reads as one tidy column and never wraps mid-strip.
import { Modal, Button, Icon } from "@dub/ui";
import type { IconName } from "@dub/ui";
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

export function ColorSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);

  // Radiogroup roving selection: Up/Down (and Left/Right) move to the adjacent option
  // and select it immediately (WAI-ARIA radio behaviour); Home/End jump to the ends.
  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const i = THEME_ORDER.indexOf(theme);
    const n = THEME_ORDER.length;
    let next: ThemeValue | undefined;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowRight":
        next = THEME_ORDER[(i + 1) % n];
        break;
      case "ArrowUp":
      case "ArrowLeft":
        next = THEME_ORDER[(i - 1 + n) % n];
        break;
      case "Home":
        next = THEME_ORDER[0];
        break;
      case "End":
        next = THEME_ORDER[n - 1];
        break;
      default:
        return;
    }
    e.preventDefault();
    if (next) setTheme(next);
  };

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
          <div
            className="fe2-theme-list"
            role="radiogroup"
            aria-label="テーマ"
            data-testid="fe2-color-theme-segmented"
          >
            {THEME_ORDER.map((value) => {
              const active = value === theme;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  className="fe2-theme-option"
                  aria-checked={active}
                  tabIndex={active ? 0 : -1}
                  onClick={() => setTheme(value)}
                  onKeyDown={onKeyDown}
                  data-testid={`fe2-theme-option-${value}`}
                >
                  <span className="fe2-theme-option-icon" aria-hidden="true">
                    <Icon name={THEME_ICON[value]} size="md" />
                  </span>
                  <span className="fe2-theme-option-body">
                    <span className="fe2-theme-option-label">{THEME_LABEL[value]}</span>
                    <span className="fe2-theme-option-hint">{THEME_HINT[value]}</span>
                  </span>
                  <span className="fe2-theme-option-check" aria-hidden="true">
                    {active ? <Icon name="check" size="md" /> : null}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="fe2-color-current" data-testid="fe2-color-theme-current">
            現在の設定：<strong>{THEME_LABEL[theme]}</strong> — {THEME_HINT[theme]}
          </p>
        </section>
      </div>
    </Modal>
  );
}
