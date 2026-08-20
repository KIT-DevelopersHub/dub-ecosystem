// Persist the last event the user worked in (GCP-style project selector memory),
// so the global イベント header switcher resumes it and the ガント landing can skip
// its picker. A personal navigation preference — localStorage only, no backend.
// The URL param stays the source of truth for what the gantt shows; this is the
// cross-navigation memory used when the URL carries no event (e.g. the launcher).

/** Global (not per-event) key — answers "which event am I working in". */
export const SELECTED_EVENT_STORAGE_KEY = "dub:selected-event";

/** Read the last selected event id (null when never chosen / storage blocked). */
export function loadSelectedEvent(): string | null {
  try {
    const raw = globalThis.localStorage?.getItem(SELECTED_EVENT_STORAGE_KEY);
    return raw && raw.trim() ? raw : null;
  } catch {
    return null;
  }
}

/** Persist the selected event id; silently no-ops when storage is unavailable. */
export function saveSelectedEvent(eventId: string): void {
  try {
    if (eventId && eventId.trim()) globalThis.localStorage?.setItem(SELECTED_EVENT_STORAGE_KEY, eventId);
  } catch {
    /* storage blocked (private mode / quota) — navigation still works via the URL */
  }
}
