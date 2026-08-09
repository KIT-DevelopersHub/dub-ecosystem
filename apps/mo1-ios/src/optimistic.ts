// optimistic — task state-change optimistic UI (design §1, §5 S5, §6 CONFLICT).
// PATCH carries `version`; a mismatch returns 409 *_VERSION_CONFLICT and the UI
// rolls back to the pre-edit snapshot. Pure functions so the ViewModel and its
// tests share one implementation.
import { task } from "@dub/types";
import type { DubClientError } from "./errors.js";

export type TaskStatus = task.TaskStatus;

/** Is `to` reachable from `from` per the frozen transition table (FE4 shares it). */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return task.TASK_STATUS_TRANSITIONS[from].includes(to);
}

export interface OptimisticState<T> {
  /** what the UI renders right now (optimistic value while pending). */
  readonly value: T;
  /** snapshot to restore on failure; null when settled. */
  readonly rollbackTo: T | null;
  readonly pending: boolean;
}

export function settled<T>(value: T): OptimisticState<T> {
  return { value, rollbackTo: null, pending: false };
}

/** Begin an optimistic edit: show `next`, remember `current` for rollback. */
export function begin<T>(current: T, next: T): OptimisticState<T> {
  return { value: next, rollbackTo: current, pending: true };
}

/** Server confirmed: adopt the authoritative value, drop the snapshot. */
export function commit<T>(_state: OptimisticState<T>, confirmed: T): OptimisticState<T> {
  return settled(confirmed);
}

/** Server rejected: restore the snapshot (no-op if already settled). */
export function rollback<T>(state: OptimisticState<T>): OptimisticState<T> {
  if (!state.pending || state.rollbackTo === null) return settled(state.value);
  return settled(state.rollbackTo);
}

/** A 409 (incl. open *_VERSION_CONFLICT codes) means "rollback + refetch". */
export function isVersionConflict(err: DubClientError): boolean {
  return err.kind === "conflict";
}

/** Build the PATCH body for a status change with the optimistic-lock version. */
export function statusPatch(current: task.Task, status: TaskStatus): task.UpdateTaskRequest {
  return { version: current.version, status };
}
