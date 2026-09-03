// Pure presence-aggregation logic, factored out of the GanttRoom Durable Object so it is
// unit-testable without a WebSocket runtime. One connected socket = one SocketMeta; the
// room dedupes them by userId (a user with two tabs shows ONE avatar) and orders the
// result stably (by displayName then userId) so the avatar row never jitters.
import type { common, gantt } from "@dub/types";

/** Per-socket metadata; survives DO hibernation via serializeAttachment. */
export interface SocketMeta {
  userId: common.UserId;
  eventId: common.EventId;
  /** Best-effort human label the DO learned at connect (currently unset — identity is a
   *  bare userId server-side; the client resolves the name from its roster). */
  displayName?: string;
  /** epoch-ms the socket connected; only used for deterministic tie-breaking. */
  connectedAt: number;
}

/** Collapse the live socket metas into the wire presence snapshot: deduped by userId
 *  (first-seen wins for the optional displayName), stable order by displayName then id. */
export function buildPresenceSnapshot(metas: readonly SocketMeta[]): gantt.GanttPresenceUser[] {
  const byUser = new Map<common.UserId, gantt.GanttPresenceUser>();
  for (const m of metas) {
    if (byUser.has(m.userId)) continue; // one avatar per user, regardless of tab count
    byUser.set(m.userId, {
      userId: m.userId,
      ...(m.displayName ? { displayName: m.displayName } : {}),
    });
  }
  return [...byUser.values()].sort((a, b) =>
    (a.displayName ?? a.userId).localeCompare(b.displayName ?? b.userId, "ja"),
  );
}
