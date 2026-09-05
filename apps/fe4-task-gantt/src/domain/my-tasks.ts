// My Tasks hub — pure domain logic (no React, no I/O) so filtering/sorting is unit
// tested in isolation. The hub unifies two lenses over the frozen task-service:
//   担当 (assigned): GET /tasks?assigneeId=<self>   — tasks assigned TO me
//   依頼 (requested): GET /tasks?createdById=<self>  — tasks I issued (from me)
// Both are self-scoped, so eventId may be omitted (server /me rule). The "すべて"
// lens fetches both and de-duplicates. Requester = task.createdBy (from→to "from").
import type { task, common } from "@dub/types";

export type MyTasksLens = "assigned" | "requested" | "all";
export type DueBucket = "all" | "overdue" | "today" | "week" | "none";
export type TaskSort = "due" | "priority" | "updated" | "created" | "title";

export interface MyTasksFilter {
  search: string;
  status: task.TaskStatus[];
  /** narrow to a specific assignee (to) — options come from the roster in scope. */
  assigneeId?: common.UserId;
  /** narrow to a specific requester (from). */
  requesterId?: common.UserId;
  /** client-side team filter (task.teamId; persisted in demo, best-effort in prod). */
  teamId?: common.TeamId;
  due: DueBucket;
  sort: TaskSort;
}

export function emptyMyTasksFilter(): MyTasksFilter {
  return { search: "", status: [], due: "all", sort: "due" };
}

export function myTasksFilterActiveCount(f: MyTasksFilter): number {
  return (
    f.status.length +
    (f.search.trim() ? 1 : 0) +
    (f.assigneeId ? 1 : 0) +
    (f.requesterId ? 1 : 0) +
    (f.teamId ? 1 : 0) +
    (f.due !== "all" ? 1 : 0)
  );
}

/** Which backend queries a lens needs.
 *  担当/依頼 stay self-scoped (eventId omitted; the server's /me rule). 「すべて」 is
 *  parity with the ガント: the gantt is event-scoped and shows EVERY task in the event
 *  (gantt-service forwards `GET /tasks?eventId=` to task-service), so a self-scoped
 *  すべて would only ever show the viewer's own tasks and never match the timeline. To
 *  keep マイタスク and ガント on the SAME task set, すべて fetches each of the user's
 *  events (same event-scoped call the gantt makes) and unions the result — see
 *  `allTasksQueries`. */
export function lensQueries(currentUserId: common.UserId, lens: MyTasksLens): task.ListTasksQuery[] {
  const assigned: task.ListTasksQuery = { assigneeId: currentUserId, limit: 200 };
  const requested: task.ListTasksQuery = { createdById: currentUserId, limit: 200 };
  switch (lens) {
    case "assigned":
      return [assigned];
    case "requested":
      return [requested];
    case "all":
      // Fallback only (no events in scope): union of the two self-scoped lenses so
      // すべて never regresses to empty when the event list failed to load.
      return [assigned, requested];
  }
}

/** Queries for the 「すべて」 lens — parity with the ガント. One event-scoped query per
 *  event the user can see (the SAME `GET /tasks?eventId=` gantt-service issues upstream,
 *  so マイタスク renders the identical task set the timeline does), unioned with the
 *  user's self-scoped tasks so personal / event-unlinked tasks (判断44) are never
 *  dropped. Merge + de-dupe with `mergeTasks`. */
export function allTasksQueries(
  currentUserId: common.UserId,
  eventIds: readonly common.EventId[],
): task.ListTasksQuery[] {
  const perEvent = eventIds.map((eventId): task.ListTasksQuery => ({ eventId, limit: 200 }));
  const self: task.ListTasksQuery[] = [
    { assigneeId: currentUserId, limit: 200 },
    { createdById: currentUserId, limit: 200 },
  ];
  return [...perEvent, ...self];
}

/** Merge several task pages into one list, de-duplicated by id (last write wins). */
export function mergeTasks(...lists: readonly task.Task[][]): task.Task[] {
  const byId = new Map<common.TaskId, task.Task>();
  for (const list of lists) for (const t of list) byId.set(t.id, t);
  return [...byId.values()];
}

const MS_PER_DAY = 86_400_000;

/** True when the task is past due and still open (drives the overdue accent). */
export function isOverdue(t: task.Task, now: number): boolean {
  if (!t.dueAt) return false;
  if (t.status === "done" || t.status === "cancelled") return false;
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  return Date.parse(t.dueAt) < startOfToday.getTime();
}

function matchesDue(t: task.Task, bucket: DueBucket, now: number): boolean {
  if (bucket === "all") return true;
  if (bucket === "none") return t.dueAt === null;
  if (bucket === "overdue") return isOverdue(t, now);
  if (!t.dueAt) return false;
  const due = Date.parse(t.dueAt);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTomorrow = startOfToday.getTime() + MS_PER_DAY;
  if (bucket === "today") return due >= startOfToday.getTime() && due < startOfTomorrow;
  // "week": due within the next 7 days (today through +6 days)
  return due >= startOfToday.getTime() && due < startOfTomorrow + 6 * MS_PER_DAY;
}

/** Apply all client-side filters (search/status/assignee/requester/team/due). */
export function applyMyTasksFilter(
  tasks: readonly task.Task[],
  f: MyTasksFilter,
  now: number = Date.now(),
): task.Task[] {
  const q = f.search.trim().toLowerCase();
  const statusSet = new Set(f.status);
  return tasks.filter((t) => {
    if (q && !t.title.toLowerCase().includes(q)) return false;
    if (statusSet.size > 0 && !statusSet.has(t.status)) return false;
    if (f.assigneeId && t.assigneeId !== f.assigneeId) return false;
    if (f.requesterId && t.createdBy !== f.requesterId) return false;
    if (f.teamId && (t.teamId ?? null) !== f.teamId) return false;
    if (!matchesDue(t, f.due, now)) return false;
    return true;
  });
}

const PRIORITY_RANK: Record<task.TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
// Open work first, closed last — a person's hub should surface actionable items.
const STATUS_RANK: Record<task.TaskStatus, number> = {
  blocked: 0,
  in_progress: 1,
  todo: 2,
  done: 3,
  cancelled: 4,
};

/** Stable sort by the chosen key; ties break by id so paging is deterministic. */
export function sortMyTasks(tasks: readonly task.Task[], sort: TaskSort): task.Task[] {
  const arr = [...tasks];
  const cmp: Record<TaskSort, (a: task.Task, b: task.Task) => number> = {
    due: (a, b) => nullableTime(a.dueAt) - nullableTime(b.dueAt),
    priority: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
    updated: (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    created: (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    title: (a, b) => a.title.localeCompare(b.title, "ja"),
  };
  arr.sort((a, b) => {
    // Always keep open tasks above closed ones regardless of the primary key.
    const s = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (s !== 0 && (sort === "due" || sort === "priority")) return s;
    const primary = cmp[sort](a, b);
    return primary !== 0 ? primary : a.id.localeCompare(b.id);
  });
  return arr;
}

/** null due dates sort to the end (Infinity). */
function nullableTime(iso: common.ISODateTime | null): number {
  return iso ? Date.parse(iso) : Number.POSITIVE_INFINITY;
}
