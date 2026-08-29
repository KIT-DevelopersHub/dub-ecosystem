/// <reference lib="dom" />
// Shared keyboard primitives for text entry. The single source of truth for
// "Enter が送信トリガーか" across every Dub text field. The 変換確定 Enter (IME で
// 日本語/中国語/韓国語などの変換候補を確定する Enter) fires a keydown while the IME is
// still composing, and must NOT submit/send. Any custom Enter-to-submit handler in
// the ecosystem MUST route through here so new text fields inherit the correct
// behavior for free (FRONTEND_GUIDE §IME).
import { useCallback, useRef } from "react";
import type { CompositionEventHandler, KeyboardEvent as ReactKeyboardEvent, KeyboardEventHandler } from "react";

type ComposingLike = { isComposing?: boolean; keyCode?: number };
type MaybeReactKeyboardEvent = ComposingLike & { nativeEvent?: ComposingLike };

/**
 * True while an IME is composing text — including the keydown that fires when the
 * user presses Enter to confirm a conversion candidate. That confirm keydown reports
 * `isComposing === true` (legacy browsers: `keyCode === 229`). Submit/send handlers
 * MUST ignore Enter when this returns true, otherwise the 変換確定 Enter sends the
 * half-finished message. Accepts both React and native KeyboardEvents.
 */
export function isImeComposing(e: MaybeReactKeyboardEvent): boolean {
  const native = e.nativeEvent ?? e;
  return Boolean(native.isComposing) || native.keyCode === 229;
}

export interface SubmitEnterOptions {
  /** When true (default), Shift+Enter inserts a newline instead of submitting. */
  allowShiftNewline?: boolean;
}

/**
 * Whether this keydown is the "submit" Enter — i.e. a plain Enter that should send,
 * as opposed to a 変換確定 Enter (IME composing) or a Shift+Enter newline. Use this
 * inside handlers that do more than submit (mention menus, formatting shortcuts).
 */
export function isSubmitEnter(
  e: ReactKeyboardEvent | KeyboardEvent,
  opts: SubmitEnterOptions = {},
): boolean {
  if (e.key !== "Enter") return false;
  if (isImeComposing(e)) return false;
  if (e.shiftKey && opts.allowShiftNewline !== false) return false;
  return true;
}

export interface EnterToSubmitHandlers<T extends HTMLElement> {
  onKeyDown: KeyboardEventHandler<T>;
  onCompositionStart: CompositionEventHandler<T>;
  onCompositionEnd: CompositionEventHandler<T>;
}

/**
 * The default path for "Enter で送信 / Shift+Enter で改行" text fields. Spread the
 * returned handlers onto an <input>/<textarea>; the 変換確定 Enter never submits.
 * A composition ref backs up `isImeComposing` for the few browsers whose confirm
 * keydown reports `isComposing === false` just before `compositionend`.
 *
 *   const enter = useEnterToSubmit(send);
 *   <textarea {...enter} />
 */
export function useEnterToSubmit<T extends HTMLElement = HTMLElement>(
  onSubmit: (e: ReactKeyboardEvent<T>) => void,
  opts: SubmitEnterOptions = {},
): EnterToSubmitHandlers<T> {
  const composingRef = useRef(false);
  const { allowShiftNewline } = opts;

  const onCompositionStart = useCallback<CompositionEventHandler<T>>(() => {
    composingRef.current = true;
  }, []);
  const onCompositionEnd = useCallback<CompositionEventHandler<T>>(() => {
    composingRef.current = false;
  }, []);

  const onKeyDown = useCallback<KeyboardEventHandler<T>>(
    (e) => {
      if (e.key !== "Enter") return;
      if (composingRef.current || isImeComposing(e)) return;
      if (e.shiftKey && allowShiftNewline !== false) return;
      e.preventDefault();
      onSubmit(e);
    },
    [onSubmit, allowShiftNewline],
  );

  return { onKeyDown, onCompositionStart, onCompositionEnd };
}
