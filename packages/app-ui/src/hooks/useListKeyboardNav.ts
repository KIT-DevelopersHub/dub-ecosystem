// Headless active-index state for a keyboard-navigable list (combobox/listbox).
// ArrowUp/Down move with wrap-around; the index resets to `defaultIndex` whenever
// `resetKey` changes (e.g. the query text), derived during render — no effect lag.
import { useCallback, useState } from "react";

export interface UseListKeyboardNavArgs {
  /** Number of items currently rendered. */
  count: number;
  /** Changing this resets the active index to `defaultIndex`. */
  resetKey: string;
  /** Index to highlight after a reset; -1 = nothing highlighted. */
  defaultIndex?: number;
}

export interface ListKeyboardNav {
  /** Highlighted index, or -1 when nothing is highlighted. */
  activeIndex: number;
  setActiveIndex: (i: number) => void;
  /** Move by +1/-1 with wrap-around. From -1, +1 → first and -1 → last. */
  move: (delta: 1 | -1) => void;
}

export function useListKeyboardNav({ count, resetKey, defaultIndex = -1 }: UseListKeyboardNavArgs): ListKeyboardNav {
  const [state, setState] = useState<{ key: string; index: number | null }>({ key: resetKey, index: null });
  const raw = state.key === resetKey && state.index !== null ? state.index : defaultIndex;
  const activeIndex = raw >= 0 && raw < count ? raw : count > 0 && raw >= count ? count - 1 : -1;

  const setActiveIndex = useCallback((i: number) => setState({ key: resetKey, index: i }), [resetKey]);
  const move = useCallback(
    (delta: 1 | -1) => {
      if (count === 0) return;
      const next = activeIndex < 0 ? (delta === 1 ? 0 : count - 1) : (activeIndex + delta + count) % count;
      setState({ key: resetKey, index: next });
    },
    [activeIndex, count, resetKey],
  );

  return { activeIndex, setActiveIndex, move };
}
