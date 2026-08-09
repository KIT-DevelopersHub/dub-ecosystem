// Filter state <-> ListTasksQuery <-> URLSearchParams. The filter bar is shared
// by all three views and synced to the URL query (design §2-2 / test 1).
import type { task, common } from "@dub/types";

export interface TaskFilterState {
  eventId: common.EventId;
  status: task.TaskStatus[];
  assigneeId?: common.UserId;
  includeArchived: boolean;
  cursor?: string;
  limit?: number;
}

const ALL_STATUS: readonly task.TaskStatus[] = [
  "todo",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
];

function isStatus(v: string): v is task.TaskStatus {
  return (ALL_STATUS as readonly string[]).includes(v);
}

export function emptyFilter(eventId: common.EventId): TaskFilterState {
  return { eventId, status: [], includeArchived: false };
}

/** Build the wire query. `cursor` is applied by the LoadMore action, not stored. */
export function toListTasksQuery(f: TaskFilterState): task.ListTasksQuery {
  return {
    eventId: f.eventId,
    ...(f.status.length > 0 ? { status: f.status } : {}),
    ...(f.assigneeId !== undefined ? { assigneeId: f.assigneeId } : {}),
    ...(f.includeArchived ? { includeArchived: true } : {}),
    ...(f.cursor !== undefined ? { cursor: f.cursor } : {}),
    ...(f.limit !== undefined ? { limit: f.limit } : {}),
  };
}

export function filterToSearchParams(f: TaskFilterState): URLSearchParams {
  const p = new URLSearchParams();
  if (f.status.length > 0) p.set("status", f.status.join(","));
  if (f.assigneeId !== undefined) p.set("assignee", f.assigneeId);
  if (f.includeArchived) p.set("archived", "1");
  return p;
}

export function searchParamsToFilter(
  eventId: common.EventId,
  p: URLSearchParams,
): TaskFilterState {
  const statusRaw = p.get("status");
  const status = statusRaw ? statusRaw.split(",").filter(isStatus) : [];
  const assignee = p.get("assignee");
  return {
    eventId,
    status,
    ...(assignee ? { assigneeId: assignee } : {}),
    includeArchived: p.get("archived") === "1",
  };
}

/** Merge a LoadMore page into the current list without duplicates/gaps (test 1). */
export function appendPage(
  current: readonly task.Task[],
  page: task.ListTasksResponse,
): task.Task[] {
  const seen = new Set(current.map((t) => t.id));
  const merged = [...current];
  for (const t of page.items) if (!seen.has(t.id)) merged.push(t);
  return merged;
}
