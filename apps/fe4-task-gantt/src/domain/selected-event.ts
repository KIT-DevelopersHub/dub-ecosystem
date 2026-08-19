// Per-user persistence of the CURRENTLY SELECTED event (GCP-style project
// selector). The gantt is event-scoped, but the working event is almost always
// the same one session-to-session, so we remember the last pick in localStorage
// and let the header dropdown switch it anytime — no per-screen picker tap.
//
// This is a personal navigation preference (not shared data): $0, no contract
// change. The key is intentionally GLOBAL (not per-event) — it answers "which
// event am I working in", so fe2's ガント landing screen can read the SAME key to
// skip its picker and jump straight to the last event.
import { useCallback, useEffect, useState } from "react";
import type { common } from "@dub/types";

/** Shared with fe2 (GanttLandingScreen) — keep the literal in sync there. */
export const SELECTED_EVENT_STORAGE_KEY = "fe4:selected-event";

/** Read the last selected event id (null when never chosen / storage blocked). */
export function loadSelectedEvent(): common.EventId | null {
  try {
    const raw = globalThis.localStorage?.getItem(SELECTED_EVENT_STORAGE_KEY);
    return raw && raw.trim() ? (raw as common.EventId) : null;
  } catch {
    return null;
  }
}

/** Persist the selected event id; silently no-ops when storage is unavailable. */
export function saveSelectedEvent(eventId: common.EventId): void {
  try {
    globalThis.localStorage?.setItem(SELECTED_EVENT_STORAGE_KEY, eventId);
  } catch {
    /* storage blocked (private mode / quota) — the in-memory state still applies */
  }
}

/**
 * Active-event state for the gantt workspace, seeded from the URL/prop event
 * (`initialEventId` — a deep-link is authoritative on mount) and switchable via
 * the header dropdown. Every value we settle on is written through to localStorage
 * so the launcher entry (which carries no event in its URL) can resume it.
 *
 * The returned setter also best-effort syncs the browser URL to
 * `/events/:eventId/tasks/gantt` so a refresh / shared link stays consistent with
 * what's on screen — without needing the (fe2-owned) router. In the standalone
 * demo (no such path) the URL rewrite is skipped.
 */
export function useSelectedEvent(
  initialEventId: common.EventId,
): [common.EventId, (next: common.EventId) => void] {
  const [eventId, setEventId] = useState<common.EventId>(initialEventId);

  // The deep-linked event (prop) wins on mount and whenever the shell router
  // re-navigates (browser back/forward changes the parsed path → prop). Mirror it
  // into state + storage so "last selected" tracks wherever the user actually is.
  useEffect(() => {
    setEventId(initialEventId);
    saveSelectedEvent(initialEventId);
  }, [initialEventId]);

  const switchEvent = useCallback((next: common.EventId) => {
    setEventId(next);
    saveSelectedEvent(next);
    // Keep the address bar in step with the viewed event (deep-link/refresh/share
    // consistency) when we're mounted under the real event-scoped route. A bare
    // replaceState doesn't disturb the fe2 router (no navigation event), so the
    // prop-sync effect above won't fight this.
    try {
      const path = globalThis.location?.pathname ?? "";
      const m = path.match(/\/events\/[^/]+(\/tasks.*)?$/);
      if (m) {
        const suffix = m[1] ?? "/tasks/gantt";
        globalThis.history?.replaceState(null, "", `/events/${next}${suffix}`);
      }
    } catch {
      /* no History API (SSR/tests) — internal state still drives the reload */
    }
  }, []);

  return [eventId, switchEvent];
}
