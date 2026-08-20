// The "currently selected event" — a small, cross-view global selection backed by
// localStorage. This is the グローバルなイベント選択状態 the マイタスク「タスクを発行」
// modal reads to seed its 対象イベント: whichever event the user is working in (the
// one whose ガント workspace they opened) becomes the default target for a new task.
//
// Kept deliberately tiny and dependency-free so it can be shared by the event-scoped
// ガント route (which WRITES the current event on entry) and the マイタスク hub
// (which READS it) without a heavier context/store. Forward-compatible: once the FE2
// shell exposes a real header event switcher, it can write the same key.
import type { common } from "@dub/types";

const CURRENT_EVENT_KEY = "dub.fe4.currentEventId";

/** Read the globally-selected event id, or null when none has been selected yet. */
export function getCurrentEventId(): common.EventId | null {
  try {
    const v = globalThis.localStorage?.getItem(CURRENT_EVENT_KEY);
    return v ? (v as common.EventId) : null;
  } catch {
    return null; // storage unavailable (SSR / privacy mode) — degrade to "none".
  }
}

/** Persist the globally-selected event id (call when a user enters an event's view). */
export function setCurrentEventId(eventId: common.EventId | null): void {
  try {
    if (eventId) globalThis.localStorage?.setItem(CURRENT_EVENT_KEY, eventId);
    else globalThis.localStorage?.removeItem(CURRENT_EVENT_KEY);
  } catch {
    /* storage unavailable — the default simply falls back to 紐付けない. */
  }
}
