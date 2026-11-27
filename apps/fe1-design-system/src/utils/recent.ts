// useRecentSelections — "recently picked" ids for a picker (e.g. 最近選んだ人), most recent
// first, persisted per `storageKey` in localStorage. A convenience only: storage may be
// unavailable (private mode, blocked site data), so every access is try/catch and the
// hook still works in memory.
import { useCallback, useState } from "react";

export interface RecentSelections<V extends string = string> {
  /** Most recent first. */
  recent: readonly V[];
  /** Record a pick (moves it to the front; keeps at most `max`). */
  remember: (value: V) => void;
}

function read<V extends string>(key: string): V[] {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is V => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function useRecentSelections<V extends string = string>(storageKey: string, max = 5): RecentSelections<V> {
  const [state, setState] = useState<{ key: string; recent: V[] }>(() => ({ key: storageKey, recent: read<V>(storageKey) }));
  // a different key (e.g. the signed-in user changed) reloads its own list
  const recent = state.key === storageKey ? state.recent : read<V>(storageKey);
  const remember = useCallback(
    (value: V) => {
      if (!value) return;
      setState((prev) => {
        const base = prev.key === storageKey ? prev.recent : read<V>(storageKey);
        const next = [value, ...base.filter((v) => v !== value)].slice(0, max);
        try {
          globalThis.localStorage?.setItem(storageKey, JSON.stringify(next));
        } catch {
          /* storage unavailable — keep it in memory only */
        }
        return { key: storageKey, recent: next };
      });
    },
    [storageKey, max],
  );
  return { recent, remember };
}
