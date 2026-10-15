// Sidebar choices (表示/非表示, ミーティングのカレンダー) remembered per signed-in user,
// so a reload keeps them and two accounts on one browser don't share them.
import { useCallback, useState } from "react";

const PREFIX = "dub.calendar.prefs";

export function userPrefKey(name: string, userId: string): string {
  return `${PREFIX}.${name}.${userId}`;
}

function read<T>(key: string | null, decode: (v: unknown) => T, empty: T): T {
  if (!key) return empty;
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? empty : decode(JSON.parse(raw));
  } catch {
    return empty;
  }
}

function write(key: string | null, value: unknown): void {
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode / full: the choice lasts for this page only
  }
}

/**
 * useState backed by localStorage under `name` + `userId`. Before the session is known
 * (`userId` null) it holds `empty` and saves nothing, so a stored choice is never clobbered.
 */
export function useUserPref<T>(
  name: string,
  userId: string | null | undefined,
  decode: (v: unknown) => T,
  empty: T,
): [T, (update: (prev: T) => T) => void] {
  const key = userId ? userPrefKey(name, userId) : null;
  const [state, setState] = useState(() => ({ key, value: read(key, decode, empty) }));
  // Session resolved / switched account: load that user's choice once (render-time sync).
  let current = state;
  if (state.key !== key) {
    current = { key, value: read(key, decode, empty) };
    setState(current);
  }
  const update = useCallback(
    (fn: (prev: T) => T) =>
      setState((prev) => {
        const next = fn(prev.key === key ? prev.value : read(key, decode, empty));
        write(key, next);
        return { key, value: next };
      }),
    // decode / empty are module-level constants at every call site
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  return [current.value, update];
}
