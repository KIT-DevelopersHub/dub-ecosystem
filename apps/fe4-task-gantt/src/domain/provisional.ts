// Optimistic-create helpers. A newly-created task must appear on the gantt the
// same tick the user hits "作成する" — before the POST resolves. Because the
// timeline is the only canvas, we synthesize BOTH the provisional task (for the
// store cache) and its gantt row (for the chart cache), then swap them for the
// authoritative server values once the round-trip lands (see store.create +
// TaskWorkspacePage.onCreate). Pure + framework-free so it is unit-testable.
import type { task, gantt, common } from "@dub/types";

/** Nominal bar length (days) by priority — mirrors gantt-service dto.ts and the
 *  mock, so the provisional bar has the SAME width the server will return. */
const DURATION_DAYS_BY_PRIORITY: Record<task.TaskPriority, number> = {
  urgent: 1,
  high: 2,
  medium: 3,
  low: 5,
};

const MS_PER_DAY = 86_400_000;

/** A unique, obviously-temporary task id (swapped out on server confirm). */
export function provisionalTaskId(): common.TaskId {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `task_tmp_${rand}` as common.TaskId;
}

export interface ProvisionalDraft {
  title: string;
  status: task.TaskStatus;
  priority: task.TaskPriority;
  assigneeId: common.UserId | null;
  teamId: common.TeamId | null;
  startAt: common.ISODateTime | null;
  dueAt: common.ISODateTime | null;
  parentTaskId: common.TaskId | null;
}

/** A stand-in Task shown instantly in the store while the create POST is in flight. */
export function buildProvisionalTask(
  id: common.TaskId,
  draft: ProvisionalDraft,
  eventId: common.EventId,
  nowIso: common.ISODateTime,
): task.Task {
  return {
    id,
    eventId,
    title: draft.title,
    description: null,
    status: draft.status,
    priority: draft.priority,
    assigneeId: draft.assigneeId,
    teamId: draft.teamId,
    startAt: draft.startAt,
    dueAt: draft.dueAt,
    origin: "internal",
    version: 1,
    archivedAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/** Progress the gantt shows per status (mirror of gantt-service progressOf / mock). */
function progressOf(status: task.TaskStatus): number {
  return status === "done" ? 100 : 0;
}

/** The provisional bar: deadline-anchored [dueAt - durationDays, dueAt], exactly
 *  how gantt-service derives it — so the bar doesn't jump when the server row lands.
 *  `parentTaskId` is passed separately (it lives on the create request, not Task). */
export function provisionalGanttRow(
  t: task.Task,
  parentTaskId: common.TaskId | null = null,
): gantt.GanttRow {
  let startsAt: common.ISODateTime | null = null;
  let endsAt: common.ISODateTime | null = null;
  const dur = DURATION_DAYS_BY_PRIORITY[t.priority];
  // Mirror gantt-service toRow: real dates win, else derive from whichever is set.
  if (t.startAt && t.dueAt) {
    startsAt = t.startAt;
    endsAt = t.dueAt;
  } else if (t.dueAt) {
    endsAt = t.dueAt;
    startsAt = new Date(Date.parse(t.dueAt) - dur * MS_PER_DAY).toISOString() as common.ISODateTime;
  } else if (t.startAt) {
    startsAt = t.startAt;
    endsAt = new Date(Date.parse(t.startAt) + dur * MS_PER_DAY).toISOString() as common.ISODateTime;
  }
  return {
    taskId: t.id,
    title: t.title,
    startsAt,
    endsAt,
    progressPercent: progressOf(t.status),
    assigneeId: t.assigneeId,
    teamId: t.teamId ?? null,
    // Carry createdAt so the optimistic row sorts to the tail of the global creation
    // sequence and shows its final ID number immediately (no jump when the row lands).
    createdAt: t.createdAt,
    parentTaskId,
    depth: parentTaskId ? 1 : 0,
    hasChildren: false,
  };
}
