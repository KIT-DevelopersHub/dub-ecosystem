// useDraftAutosave — keep an in-progress form from being lost.
//
// Layer ② (@dub/app-ui) reusable hook: React + Web Storage only — no data
// fetching, no router, no @dub/ui / @dub/tokens dependency. It does three things
// for any form that passes its current values + a "dirty" flag:
//   1. AUTOSAVE  — debounced write of the form value to localStorage while dirty;
//                  the key is removed the moment the form goes back to empty/pristine.
//   2. RESTORE   — on mount, hand back any draft found in storage so the caller can
//                  seed its fields ("下書きを復元しました"). Empty/pristine ⇒ null.
//   3. LEAVE GUARD — a `beforeunload` prompt (reload / tab close / leaving the SPA)
//                  registered only while dirty. In-app SPA navigation is guarded by
//                  the caller's router (e.g. TanStack useBlocker); this hook owns the
//                  browser-level guard so the two never double-prompt.
//
// Adopted by mail compose (FE2), role editor (FE7) and event edit (FE3). See
// docs/FRONTEND_GUIDE.md.
import { useCallback, useEffect, useRef, useState } from "react";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function localStore(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage disabled / SSR
  }
}

export interface UseDraftAutosaveOptions<T> {
  /** Stable per-form key, e.g. `fe2.mail.compose` or `fe7.role.<id>`. */
  storageKey: string;
  /** Current form values (must be JSON-serialisable). */
  value: T;
  /**
   * True when `value` holds something worth persisting AND worth warning about on
   * leave — i.e. non-empty and different from the pristine baseline. When false the
   * stored draft is deleted and no leave guard is armed (the "空/保存済み" case).
   */
  dirty: boolean;
  /** Debounce for autosave writes, in ms. Default 400. */
  debounceMs?: number;
  /** Master switch (e.g. off while the form is read-only). Default true. */
  enabled?: boolean;
  /** Injectable storage for tests. Defaults to window.localStorage. */
  storage?: StorageLike | null;
}

export interface DraftAutosave<T> {
  /** Draft found in storage at mount, for seeding fields. null when none/disabled. */
  restored: T | null;
  /** Whether the "restored" notice should still be shown (until acknowledged/cleared). */
  restoredVisible: boolean;
  /** Dismiss the restore notice WITHOUT deleting the draft (user kept it). */
  acknowledgeRestored: () => void;
  /** Delete the stored draft and hide the notice — call on successful submit or discard. */
  clear: () => void;
}

/** Read + JSON-parse a draft once. Returns null on miss / disabled / corrupt. */
function readDraft<T>(store: StorageLike | null, key: string): T | null {
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (raw == null || raw === "") return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Peek at a persisted draft outside the hook — for seeding a `useState(() => …)`
 * initializer synchronously so fields render pre-filled. The hook itself reads the
 * same key at mount to drive the restore notice, so the two stay consistent.
 */
export function peekDraft<T>(storageKey: string, storage?: StorageLike | null): T | null {
  return readDraft<T>(storage !== undefined ? storage : localStore(), storageKey);
}

export function useDraftAutosave<T>({
  storageKey,
  value,
  dirty,
  debounceMs = 400,
  enabled = true,
  storage,
}: UseDraftAutosaveOptions<T>): DraftAutosave<T> {
  const store = storage !== undefined ? storage : localStore();

  // Read any existing draft exactly once, before the first paint, so the caller can
  // seed its state synchronously (avoids a flash of empty fields).
  const [restored] = useState<T | null>(() => (enabled ? readDraft<T>(store, storageKey) : null));
  const [restoredVisible, setRestoredVisible] = useState<boolean>(() => restored != null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearedRef = useRef(false); // set by clear() so a queued write can't resurrect the draft

  const cancelPending = useCallback(() => {
    if (timer.current != null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const removeNow = useCallback(() => {
    cancelPending();
    try {
      store?.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  }, [store, storageKey, cancelPending]);

  const clear = useCallback(() => {
    clearedRef.current = true;
    removeNow();
    setRestoredVisible(false);
  }, [removeNow]);

  const acknowledgeRestored = useCallback(() => setRestoredVisible(false), []);

  // Autosave: debounce a write while dirty; delete the key the instant it goes clean.
  useEffect(() => {
    if (!enabled || !store) return;
    if (!dirty) {
      // Empty / pristine again ⇒ nothing worth keeping.
      removeNow();
      return;
    }
    clearedRef.current = false; // fresh edits re-arm persistence after a clear()
    cancelPending();
    timer.current = setTimeout(() => {
      timer.current = null;
      if (clearedRef.current) return;
      try {
        store.setItem(storageKey, JSON.stringify(value));
      } catch {
        /* quota / disabled — a lost draft is acceptable, a crash is not */
      }
    }, debounceMs);
    return cancelPending;
  }, [enabled, store, dirty, value, storageKey, debounceMs, removeNow, cancelPending]);

  // Browser-level leave guard: reload, tab close, or navigating away from the SPA.
  useEffect(() => {
    if (!enabled || !dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ""; // required for the native prompt in Chrome/Firefox
      return "";
    };
    globalThis.addEventListener?.("beforeunload", onBeforeUnload);
    return () => globalThis.removeEventListener?.("beforeunload", onBeforeUnload);
  }, [enabled, dirty]);

  return { restored, restoredVisible, acknowledgeRestored, clear };
}
