// Board D&D drop-eligibility, sourced from the single frozen transition table
// (`task.TASK_STATUS_TRANSITIONS` — same source the server validates against, 8-2).
import { task } from "@dub/types";

type TaskStatus = task.TaskStatus;

export const BOARD_COLUMNS: readonly TaskStatus[] = [
  "todo",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
];

export function allowedTransitions(from: TaskStatus): readonly TaskStatus[] {
  return task.TASK_STATUS_TRANSITIONS[from];
}

/** true when a card in `from` may be dropped into `to` (identity move allowed). */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return task.TASK_STATUS_TRANSITIONS[from].includes(to);
}

/** columns a card currently in `from` may be dropped onto (for drop-disable UI). */
export function droppableColumns(from: TaskStatus): TaskStatus[] {
  return BOARD_COLUMNS.filter((c) => canTransition(from, c));
}
