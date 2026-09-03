// ShortcutsDialog (キーボードショートカット一覧). Lists every registered global shortcut,
// grouped by category, with the key chord rendered for the viewer's OS (⌘ on macOS, Ctrl
// on Windows/Linux). The list is derived entirely from the shortcut registry
// (shortcuts/registry.ts) — the SINGLE SOURCE OF TRUTH — so a shortcut added there shows
// up here automatically, with no duplicate list to maintain ([[dub-api-contract-sot]]).
//
// Opened two ways: from the ⚙ 設定 menu (キーボードショートカット), and via the global "?"
// hotkey (also a registry entry, so it lists itself). The "?" listener is ignored while
// typing in a field, during IME composition, or while another modal is already open, so
// it never steals a literal "?" the user meant to type.
//
// Rendering leans on @dub/ui Modal (overlay / focus-trap / Esc / scroll-lock) and
// @dub/tokens spacing; FE2 owns only composition + the registry wiring.
import { useEffect } from "react";
import { Modal, Icon, isImeComposing } from "@dub/ui";
import {
  SHORTCUTS,
  SHORTCUTS_HELP_SHORTCUT,
  formatChord,
  getPlatform,
  matchChord,
  type ShortcutDef,
} from "./shortcuts/registry.ts";

export interface ShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  testId?: string;
}

interface Category {
  name: string;
  items: ShortcutDef[];
}

// Group the flat registry into its categories, preserving registry order within each.
function toCategories(defs: readonly ShortcutDef[]): Category[] {
  const order: string[] = [];
  const byCat = new Map<string, ShortcutDef[]>();
  for (const d of defs) {
    if (!byCat.has(d.category)) {
      byCat.set(d.category, []);
      order.push(d.category);
    }
    byCat.get(d.category)!.push(d);
  }
  return order.map((name) => ({ name, items: byCat.get(name)! }));
}

// True when the keydown originates from an editable field, so the "?" hotkey never fires
// while the user is actually typing a question mark.
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export function ShortcutsDialog({
  open,
  onOpenChange,
  testId = "fe2-shortcuts",
}: ShortcutsDialogProps): JSX.Element {
  // Global "?" hotkey — open the list from anywhere. Guarded so it does not hijack a
  // literal "?" being typed, an IME composition, or fire atop another open modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (open) return;
      if (isTypingTarget(e.target) || isImeComposing(e)) return;
      // Don't open on top of another modal (e.g. the command palette / account settings).
      if (typeof document !== "undefined" && document.querySelector('[aria-modal="true"]')) return;
      if (matchChord(e, SHORTCUTS_HELP_SHORTCUT.chord)) {
        e.preventDefault();
        onOpenChange(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  const platform = getPlatform();
  const categories = toCategories(SHORTCUTS);

  return (
    <Modal
      open={open}
      onClose={() => onOpenChange(false)}
      title="キーボードショートカット"
      size="md"
      testId={testId}
    >
      <p className="fe2-shortcuts-intro">
        現在利用できるショートカットの一覧です。今後追加されたショートカットもここに自動で表示されます。
      </p>
      <div className="fe2-shortcuts-groups">
        {categories.map((cat) => (
          <section key={cat.name} className="fe2-shortcuts-group">
            <h3 className="fe2-shortcuts-group-title">{cat.name}</h3>
            <ul className="fe2-shortcuts-list">
              {cat.items.map((s) => (
                <li key={s.id} className="fe2-shortcuts-row" data-testid={`${testId}-row-${s.id}`}>
                  <span className="fe2-shortcuts-row-label">{s.label}</span>
                  <span className="fe2-shortcuts-keys" aria-label={formatChord(s.chord, platform).join(" ")}>
                    {formatChord(s.chord, platform).map((token, i) => (
                      <kbd key={i} className="fe2-shortcuts-kbd">
                        {token}
                      </kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="fe2-shortcuts-hint">
        <Icon name="info" size="sm" /> どの画面からでも{" "}
        <kbd className="fe2-shortcuts-kbd">?</kbd> でこの一覧を開けます。
      </p>
    </Modal>
  );
}
