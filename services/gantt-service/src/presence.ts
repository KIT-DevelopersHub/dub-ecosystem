// Pure presence-aggregation logic, factored out of the Durable Object so it is unit-
// testable without a WebSocket runtime. One connected socket = one SocketMeta; the room
// dedupes them by userId (a user with two tabs shows ONE avatar) and unions their edit
// state (editing if ANY tab is editing).
import type { common, gantt } from "@dub/types";

/** Per-socket metadata; survives DO hibernation via serializeAttachment. */
export interface SocketMeta {
  userId: common.UserId;
  displayName?: string;
  editing: boolean;
  editingTaskId?: common.TaskId | null;
  /** epoch-ms of the last frame from this socket (heartbeat/state). Drives TTL reaping. */
  lastSeen: number;
}

/** Collapse the live socket metas into the wire presence snapshot (deduped by userId,
 *  stable order by first-seen displayName then userId so the avatar row does not jitter). */
export function buildPresenceSnapshot(metas: readonly SocketMeta[]): gantt.GanttPresenceUser[] {
  const byUser = new Map<common.UserId, gantt.GanttPresenceUser>();
  for (const m of metas) {
    const existing = byUser.get(m.userId);
    const editingTaskIds = existing ? [...existing.editingTaskIds] : [];
    if (m.editing && m.editingTaskId && !editingTaskIds.includes(m.editingTaskId)) {
      editingTaskIds.push(m.editingTaskId);
    }
    byUser.set(m.userId, {
      userId: m.userId,
      // prefer any non-empty displayName seen for this user
      ...(existing?.displayName || m.displayName ? { displayName: existing?.displayName || m.displayName } : {}),
      editing: (existing?.editing ?? false) || m.editing,
      editingTaskIds,
    });
  }
  return [...byUser.values()].sort((a, b) =>
    (a.displayName ?? a.userId).localeCompare(b.displayName ?? b.userId, "ja"),
  );
}

/** True when two snapshots are observably identical (so the DO can skip a redundant
 *  broadcast — presence churn is chatty otherwise). Order is already stable above. */
export function presenceEqual(a: readonly gantt.GanttPresenceUser[], b: readonly gantt.GanttPresenceUser[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.userId !== y.userId || x.displayName !== y.displayName || x.editing !== y.editing) return false;
    if (x.editingTaskIds.length !== y.editingTaskIds.length) return false;
    for (let j = 0; j < x.editingTaskIds.length; j++) if (x.editingTaskIds[j] !== y.editingTaskIds[j]) return false;
  }
  return true;
}
