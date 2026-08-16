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

/** A reversible action. `undo` puts the world back; `redo` re-applies it. Both may
 *  be async (they can re-issue API calls). `label` powers "元に戻す: <label>" hints. */
export interface UndoableCommand {
  label?: string;
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

  return {
    push,
    undo,
    redo,
    clear,
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
      const key = e.key.toLowerCase();
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
