// Client-side presence for the chat UI (online / away / offline dots).
//
// Presence is a display-only concern here: in production it would be fed by the
// realtime channel, but for the standalone demo + shell mount we expose a small
// in-memory provider seeded by dev data. FE-only — no backend contract.
import type { common } from "@dub/types";

export type Presence = "online" | "away" | "offline";

const state = new Map<common.UserId, Presence>();

/** Seed / replace the presence map (demo bootstrap). */
export function setPresence(entries: Record<common.UserId, Presence>): void {
  for (const [id, p] of Object.entries(entries)) state.set(id, p);
}

/** Presence for a user; defaults to "offline" when unknown. */
export function getPresence(userId: common.UserId): Presence {
  return state.get(userId) ?? "offline";
}
