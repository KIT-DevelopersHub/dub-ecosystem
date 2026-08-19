// Per-user persistence of the task-number PREFIX (e.g. "AA"). Like the sort mode,
// the prefix is a personal VIEW preference — it changes only the on-screen label,
// not any stored data — so it lives in localStorage keyed by event: no server
// round-trip, no contract change, $0. (When an event-level canonical prefix is
// wanted later, this hook is the single seam to swap for an event-setting read.)
import { useCallback, useState } from "react";
import type { common } from "@dub/types";
import { DEFAULT_PREFIX, sanitizePrefix } from "./task-number";

function storageKey(eventId: common.EventId): string {
  return `fe4:gantt-number-prefix:${eventId}`;
}

/** Read the saved prefix (defaults to "AA"); tolerant of no/blocked storage. */
export function loadPrefix(eventId: common.EventId): string {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(eventId));
    return raw == null ? DEFAULT_PREFIX : sanitizePrefix(raw);
  } catch {
    return DEFAULT_PREFIX;
  }
}

/** Persist the prefix; silently no-ops when storage is unavailable. */
export function savePrefix(eventId: common.EventId, prefix: string): void {
  try {
    globalThis.localStorage?.setItem(storageKey(eventId), sanitizePrefix(prefix));
  } catch {
    /* storage blocked (private mode / quota) — the in-memory state still applies */
  }
}

/** Prefix state backed by localStorage. Optimistic: the setter updates state
 *  immediately (numbers re-render the same tick) and writes through to storage. */
export function useTaskNumberPrefix(
  eventId: common.EventId,
): [string, (prefix: string) => void] {
  const [prefix, setPrefix] = useState<string>(() => loadPrefix(eventId));
  const set = useCallback(
    (next: string) => {
      const clean = sanitizePrefix(next);
      setPrefix(clean);
      savePrefix(eventId, clean);
    },
    [eventId],
  );
  return [prefix, set];
}
