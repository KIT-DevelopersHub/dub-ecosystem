// useUndoableAction — a shared "delayed-commit undo" helper for destructive ops
// ([[optimistic-ui-principle]], FRONTEND_GUIDE §5.3).
//
// Layer ② (@dub/app-ui) reusable hook. The pattern: the moment the user confirms a
// destructive action (delete / archive / stop) we reflect it in the UI immediately
// (`apply`), show an "元に戻す" toast for a short grace window, and DEFER the real
// server commit until that window elapses. If the user hits undo we `restore` and
// never commit; otherwise `commit` fires once. Unlike a fire-and-rollback delete,
// the destructive API call is delayed so undo is truly free during the window.
//
// First adopted by FE4 (task delete) + FE3 (event archive); meant to be reused
// across FE2〜FE7. Uses the FE1 `useToast` action affordance.
import { useCallback, useEffect, useRef } from "react";
import { useToast } from "@dub/ui";

export interface UndoableActionInput {
  /** Reflect the destructive change in the UI right away (remove the row / tombstone it). */
  apply: () => void;
  /** Put the UI back when the user undoes within the grace window. */
  restore: () => void;
  /** Perform the real destructive commit (e.g. DELETE). Runs once, after the window, unless undone. */
  commit: () => void | Promise<void>;
  /** Toast title shown during the grace window (e.g. "タスクを削除しました"). */
  message: string;
  /** Undo button label. Default "元に戻す". */
  undoLabel?: string;
  /** Grace window in ms before commit fires. Default 5000 (matches the toast auto-dismiss). */
  delayMs?: number;
  /** Called if commit() rejects — surface an error toast + reconcile here. */
  onCommitError?: (error: unknown) => void;
}

export interface UndoableAction {
  /** Start an undoable destructive action: apply now, commit after the grace window unless undone. */
  run: (input: UndoableActionInput) => void;
  /** Immediately commit every still-pending action (e.g. before navigating away). */
  flushPending: () => void;
}

interface PendingRecord {
  timer: ReturnType<typeof setTimeout>;
  /** Fire the real commit now (idempotent — undo/flush/timer all funnel through here). */
  fire: () => void;
  /** Cancel + restore (idempotent). */
  cancel: () => void;
}

/**
 * useUndoableAction — orchestrates optimistic-apply + undo toast + deferred commit.
 * Multiple actions can be in flight; each has its own grace window and toast. Pending
 * commits are flushed (committed) on unmount so a delete is never silently dropped.
 */
export function useUndoableAction(): UndoableAction {
  const { show } = useToast();
  const pending = useRef<Set<PendingRecord>>(new Set());

  const run = useCallback(
    (input: UndoableActionInput) => {
      const delay = input.delayMs ?? 5000;
      let settled = false; // commit-or-undo guard: whichever happens first wins

      input.apply();

      const rec: PendingRecord = {
        timer: setTimeout(() => rec.fire(), delay),
        fire: () => {
          if (settled) return;
          settled = true;
          clearTimeout(rec.timer);
          pending.current.delete(rec);
          void (async () => {
            try {
              await input.commit();
            } catch (error) {
              input.onCommitError?.(error);
            }
          })();
        },
        cancel: () => {
          if (settled) return;
          settled = true;
          clearTimeout(rec.timer);
          pending.current.delete(rec);
          input.restore();
        },
      };
      pending.current.add(rec);

      show({
        kind: "info",
        title: input.message,
        durationMs: delay,
        action: { label: input.undoLabel ?? "元に戻す", onClick: rec.cancel },
      });
    },
    [show],
  );

  const flushPending = useCallback(() => {
    // Copy first: fire() mutates the set as it commits each record.
    for (const rec of [...pending.current]) rec.fire();
  }, []);

  // On unmount, commit anything still in its grace window — the user asked to delete;
  // dropping it silently would be worse than committing slightly early.
  const flushRef = useRef(flushPending);
  flushRef.current = flushPending;
  useEffect(() => () => flushRef.current(), []);

  return { run, flushPending };
}
