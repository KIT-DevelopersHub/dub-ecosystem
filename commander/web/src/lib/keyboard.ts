// Enter-to-submit helper for Commander text fields.
//
// Mirror of the ecosystem's single source of truth, @dub/ui
// (apps/fe1-design-system/src/utils/keyboard.ts) — Commander is a standalone
// Vite app that only depends on @dub/tokens (not the full design system), so we
// keep a tiny local copy rather than pull @dub/ui into its build graph. Keep the
// two in sync.
//
// Why: while an IME (Japanese/Chinese/Korean) is composing, pressing Enter
// CONFIRMS the conversion — it must NOT send the message. Browsers report
// `isComposing === true` on that keydown (legacy engines: `keyCode === 229`).

type ComposingLike = { isComposing?: boolean; keyCode?: number };
type MaybeReactKeyboardEvent = ComposingLike & { nativeEvent?: ComposingLike };

/** True while an IME is composing — including the Enter that confirms a candidate. */
export function isImeComposing(e: MaybeReactKeyboardEvent): boolean {
  const native = e.nativeEvent ?? e;
  return Boolean(native.isComposing) || native.keyCode === 229;
}

/**
 * Whether this keydown is the "submit" Enter — a plain Enter that should send,
 * as opposed to a 変換確定 Enter (IME composing) or a Shift+Enter newline.
 */
export function isSubmitEnter(e: MaybeReactKeyboardEvent & { key: string; shiftKey: boolean }): boolean {
  if (e.key !== "Enter") return false;
  if (isImeComposing(e)) return false;
  if (e.shiftKey) return false;
  return true;
}
