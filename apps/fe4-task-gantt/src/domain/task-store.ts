// Pure task-cache reducer shared by all three views. Holds the optimistic-update
// / rollback / version logic independent of React so it is directly testable
// (design §2-2 useTaskStore, tests 2/3/5/9). The zustand store (store/) is a
// thin wrapper over these functions.
import type { task, common } from "@dub/types";

export type TaskMap = Readonly<Record<common.TaskId, task.Task>>;

export interface OptimisticPatch {
  id: common.TaskId;
  changes: Partial<Pick<task.Task, "status" | "dueAt" | "assigneeId" | "title" | "description" | "priority">>;
}

export interface Snapshot {
  id: common.TaskId;
  /** the full previous entry, or null if the task was absent. */
  previous: task.Task | null;
}

export function indexTasks(list: readonly task.Task[]): TaskMap {
  const m: Record<common.TaskId, task.Task> = {};
  for (const t of list) m[t.id] = t;
  return m;
}

export function upsert(map: TaskMap, t: task.Task): TaskMap {
  return { ...map, [t.id]: t };
}

export function remove(map: TaskMap, id: common.TaskId): TaskMap {
  const next = { ...map };
  delete next[id];
  return next;
}

/**
 * Apply an optimistic change and return [nextMap, snapshot]. Optimistic edits do
 * NOT bump version — the server owns version; the confirmed server Task replaces
 * the entry on success (see `confirm`). If the id is unknown the map is unchanged.
 */
export function applyOptimistic(map: TaskMap, patch: OptimisticPatch): [TaskMap, Snapshot] {
  const current = map[patch.id];
  const snapshot: Snapshot = { id: patch.id, previous: current ?? null };
  if (!current) return [map, snapshot];
  const next: task.Task = { ...current, ...patch.changes };
  return [{ ...map, [patch.id]: next }, snapshot];
}

/** Restore the pre-optimistic state (409 / any failure). */
export function rollback(map: TaskMap, snapshot: Snapshot): TaskMap {
  if (snapshot.previous === null) return remove(map, snapshot.id);
  return { ...map, [snapshot.id]: snapshot.previous };
}

/** Replace with the authoritative server Task (carries the new version). */
export function confirm(map: TaskMap, server: task.Task): TaskMap {
  return { ...map, [server.id]: server };
}

export function toList(map: TaskMap): task.Task[] {
  return Object.values(map);
}

export function byStatus(map: TaskMap, status: task.TaskStatus): task.Task[] {
  return toList(map).filter((t) => t.status === status);
}
