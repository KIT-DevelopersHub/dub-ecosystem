// useUndoRedo — a framework-only, app-agnostic undo/redo command stack.
//
// Layer ② (@dub/app-ui) reusable hook: no data fetching, no router, no @dub/ui or
// @dub/tokens dependency — just React. Any app pushes *reversible commands* (an
// `undo`/`redo` pair, each possibly async so it works with server-backed optimistic
// UI) and drives them with Ctrl/⌘-Z. First adopted by FE4 (gantt bar drags), meant
// to be reused across FE2〜FE7.
//
// Command model (not state-snapshot): each mutation supplies how to reverse itself,
// which suits server-backed state (re-issue the inverse API call) far better than
// deep-cloning an entire cache. See docs/FRONTEND_GUIDE.md.
import { useCallback, useEffect, useRef, useState } from "react";

/** A confirmation prompt a command can request before its `undo` runs. Heavy or
 *  destructive inverses (e.g. restoring a deleted record — which re-writes to the
 *  server) set this so the driver raises a dialog first instead of reversing silently.
 *  The hook itself never blocks; it only exposes the descriptor (see `peekUndo`). */
export interface UndoConfirm {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

/** A reversible action. `undo` puts the world back; `redo` re-applies it. Both may
 *  be async (they can re-issue API calls). `label` powers "元に戻す: <label>" hints.
 *  `confirm`, when present, asks the driver to confirm before running `undo`. */
export interface UndoableCommand {
  label?: string;
  confirm?: UndoConfirm;
  undo: () => void | Promise<void>;
  redo: () => void | Promise<void>;
}

export interface UndoRedo {
  /** Record a just-performed action so it can be reversed. Clears the redo stack. */
  push: (cmd: UndoableCommand) => void;
  /** Reverse the most recent action. Resolves false when there's nothing to undo. */
  undo: () => Promise<boolean>;
  /** Re-apply the most recently undone action. False when there's nothing to redo. */
  redo: () => Promise<boolean>;
  /** Drop all history (e.g. when the underlying document is reloaded/replaced). */
  clear: () => void;
  /** Peek the command that the next `undo()` would reverse WITHOUT running it — lets a
   *  driver read `.confirm` and gate a heavy inverse behind a dialog. Undefined at the
   *  boundary (empty undo stack). */
  peekUndo: () => UndoableCommand | undefined;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | undefined;
  redoLabel: string | undefined;
}

export interface UseUndoRedoOptions {
  /** Cap the history depth; the oldest entry is dropped past this. Default 50. */
  limit?: number;
}

export function useUndoRedo(options: UseUndoRedoOptions = {}): UndoRedo {
  const limit = options.limit ?? 50;
  const undoStack = useRef<UndoableCommand[]>([]);
  const redoStack = useRef<UndoableCommand[]>([]);
  // A single in-flight guard so a held-down Ctrl-Z can't interleave async inverses.
  const busy = useRef(false);
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);

  const push = useCallback(
    (cmd: UndoableCommand) => {
      undoStack.current.push(cmd);
      if (undoStack.current.length > limit) undoStack.current.shift();
      redoStack.current = []; // a fresh action invalidates the redo branch
      rerender();
    },
    [limit, rerender],
  );

  const undo = useCallback(async (): Promise<boolean> => {
    if (busy.current) return false;
    const cmd = undoStack.current[undoStack.current.length - 1];
    if (!cmd) return false; // boundary: empty history — a harmless no-op
    busy.current = true;
    rerender();
    try {
      await cmd.undo();
      undoStack.current.pop();
      redoStack.current.push(cmd);
      return true;
    } finally {
      busy.current = false;
      rerender();
    }
  }, [rerender]);

  const redo = useCallback(async (): Promise<boolean> => {
    if (busy.current) return false;
    const cmd = redoStack.current[redoStack.current.length - 1];
    if (!cmd) return false;
    busy.current = true;
    rerender();
    try {
      await cmd.redo();
      redoStack.current.pop();
      undoStack.current.push(cmd);
      return true;
    } finally {
      busy.current = false;
      rerender();
    }
  }, [rerender]);

  const clear = useCallback(() => {
    undoStack.current = [];
    redoStack.current = [];
    rerender();
  }, [rerender]);

  const peekUndo = useCallback(
    (): UndoableCommand | undefined => undoStack.current[undoStack.current.length - 1],
    [],
  );

  return {
    push,
    undo,
    redo,
    clear,
    peekUndo,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
    undoLabel: undoStack.current[undoStack.current.length - 1]?.label,
    redoLabel: redoStack.current[redoStack.current.length - 1]?.label,
  };
}

export interface UndoRedoHotkeysOptions {
  /** Turn the global binding on/off (e.g. read-only users). Default true. */
  enabled?: boolean;
  /** Where to listen (defaults to window). */
  target?: Window | Document | HTMLElement | null;
}

/** True when focus is in a text-editing surface, so we must NOT steal the browser's
 *  native text-undo (Ctrl-Z inside an input/textarea/select/contenteditable). */
function isEditableTarget(el: EventTarget | null): boolean {
  const n = el as HTMLElement | null;
  if (!n || typeof n.tagName !== "string") return false;
  const tag = n.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return n.isContentEditable === true;
}

/**
 * Bind Ctrl/⌘-Z (undo) and Ctrl/⌘-Shift-Z or Ctrl-Y (redo) globally. Skips the
 * shortcut while a text field is focused so typing's native undo keeps working.
 */
export function useUndoRedoHotkeys(
  hist: Pick<UndoRedo, "undo" | "redo">,
  options: UndoRedoHotkeysOptions = {},
): void {
  const { enabled = true, target } = options;
  const { undo, redo } = hist;
  useEffect(() => {
    if (!enabled) return;
    const el: (Window | Document | HTMLElement) | null =
      target ?? (typeof window !== "undefined" ? window : null);
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      // Never hijack the keystroke while an IME is composing (変換確定中): its
      // keydown reports isComposing=true (legacy browsers: keyCode 229). Mirrors the
      // IME guard in fe1-design-system/utils/keyboard.ts so undo doesn't fire mid-変換.
      if (e.isComposing || (e as unknown as { keyCode?: number }).keyCode === 229) return;
      const key = e.key.toLowerCase();
      // OS-standard: undo = ⌘Z (mac) / Ctrl+Z (win/linux). redo = ⇧⌘Z / ⇧Ctrl+Z, plus
      // Ctrl+Y (the conventional Windows/Linux redo). metaKey||ctrlKey covers both
      // platforms without a userAgent sniff.
      const isUndo = key === "z" && !e.shiftKey;
      const isRedo = (key === "z" && e.shiftKey) || key === "y";
      if (!isUndo && !isRedo) return;
      if (isEditableTarget(e.target)) return; // let the field's own undo win
      e.preventDefault();
      if (isUndo) void undo();
      else void redo();
    };
    el.addEventListener("keydown", onKey as EventListener);
    return () => el.removeEventListener("keydown", onKey as EventListener);
  }, [enabled, target, undo, redo]);
}
