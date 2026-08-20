// Global "current event" — the event selected in the app header. Persisted to
// localStorage so a reload keeps the same event in focus. This is the FE3-owned
// selector; when the FE2 shell grows a global event switcher it can drive this
// same store (or replace it) without touching the pages that read useCurrentEventId.
import { create } from "zustand";
import type { common } from "@dub/types";

const LS_KEY = "fe3-current-event";

function readInitial(): common.EventId | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(LS_KEY);
  } catch {
    return null;
  }
}

interface CurrentEventState {
  eventId: common.EventId | null;
  setEventId: (id: common.EventId | null) => void;
}

export const useCurrentEventStore = create<CurrentEventState>((set) => ({
  eventId: readInitial(),
  setEventId: (id) => {
    if (typeof localStorage !== "undefined") {
      try {
        if (id) localStorage.setItem(LS_KEY, id);
        else localStorage.removeItem(LS_KEY);
      } catch {
        /* private mode — non-fatal */
      }
    }
    set({ eventId: id });
  },
}));

export function useCurrentEventId(): common.EventId | null {
  return useCurrentEventStore((s) => s.eventId);
}
export function useSetCurrentEventId(): (id: common.EventId | null) => void {
  return useCurrentEventStore((s) => s.setEventId);
}
