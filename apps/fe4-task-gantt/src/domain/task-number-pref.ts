// Per-user persistence of the task-number VIEW preferences: the zero-pad width and
// whether the number badge is shown. Both change only the on-screen label, not any
// stored data, so they live in localStorage keyed by event: no server round-trip, no
// contract change, $0. (The ID PREFIX is no longer a preference — it is derived from
// each task's owning team; see domain/team-code.ts.)
import { useCallback, useState } from "react";
import type { common } from "@dub/types";
import { DEFAULT_PAD_WIDTH, clampPadWidth } from "./task-number";

function padStorageKey(eventId: common.EventId): string {
  return `fe4:gantt-number-pad:${eventId}`;
}

function visibleStorageKey(eventId: common.EventId): string {
  return `fe4:gantt-number-visible:${eventId}`;
}

/** Read the saved pad width (defaults to 4); tolerant of no/blocked/garbage storage. */
export function loadPadWidth(eventId: common.EventId): number {
  try {
    const raw = globalThis.localStorage?.getItem(padStorageKey(eventId));
    if (raw == null) return DEFAULT_PAD_WIDTH;
    const n = Number(raw);
    return Number.isFinite(n) ? clampPadWidth(n) : DEFAULT_PAD_WIDTH;
  } catch {
    return DEFAULT_PAD_WIDTH;
  }
}

/** Persist the pad width; silently no-ops when storage is unavailable. */
export function savePadWidth(eventId: common.EventId, width: number): void {
  try {
    globalThis.localStorage?.setItem(padStorageKey(eventId), String(clampPadWidth(width)));
  } catch {
    /* storage blocked (private mode / quota) — the in-memory state still applies */
  }
}

/** Pad-width state backed by localStorage (default 4 digits). Optimistic like the
 *  prefix: the setter updates state immediately and writes through to storage. */
export function useTaskNumberPadWidth(
  eventId: common.EventId,
): [number, (width: number) => void] {
  const [width, setWidth] = useState<number>(() => loadPadWidth(eventId));
  const set = useCallback(
    (next: number) => {
      const clean = clampPadWidth(next);
      setWidth(clean);
      savePadWidth(eventId, clean);
    },
    [eventId],
  );
  return [width, set];
}

/** Read whether the number badge is shown (defaults to true). Only an explicit
 *  "false" hides it, so any missing/garbage value keeps the badge visible. */
export function loadNumberVisible(eventId: common.EventId): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(visibleStorageKey(eventId));
    return raw !== "false";
  } catch {
    return true;
  }
}

/** Persist the badge visibility; silently no-ops when storage is unavailable. */
export function saveNumberVisible(eventId: common.EventId, visible: boolean): void {
  try {
    globalThis.localStorage?.setItem(visibleStorageKey(eventId), visible ? "true" : "false");
  } catch {
    /* storage blocked (private mode / quota) — the in-memory state still applies */
  }
}

/** Badge-visibility state backed by localStorage (default ON). Optimistic like the
 *  other number prefs: the setter flips state immediately and writes through. */
export function useTaskNumberVisible(
  eventId: common.EventId,
): [boolean, (visible: boolean) => void] {
  const [visible, setVisible] = useState<boolean>(() => loadNumberVisible(eventId));
  const set = useCallback(
    (next: boolean) => {
      setVisible(next);
      saveNumberVisible(eventId, next);
    },
    [eventId],
  );
  return [visible, set];
}
