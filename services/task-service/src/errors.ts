// task-service specific error codes (open half of the catalog, SCREAMING_SNAKE).
// Common codes (VALIDATION_FAILED / FORBIDDEN / UNAUTHENTICATED) come from
// @dub/errors directly; these are the TASK_* contract codes (task-service.md §6).
import { DubError } from "@dub/errors";

export const TaskErrorCodes = {
  NOT_FOUND: "TASK_NOT_FOUND", // 404 missing / archived taskId
  EVENT_NOT_FOUND: "TASK_EVENT_NOT_FOUND", // 404 eventId not in event-service
  VERSION_CONFLICT: "TASK_VERSION_CONFLICT", // 409 optimistic lock mismatch
  DEPENDENCY_CYCLE: "TASK_DEPENDENCY_CYCLE", // 409 cycle (gantt-calc validateDependencies)
  INVALID_STATUS_TRANSITION: "TASK_INVALID_STATUS_TRANSITION", // 409 not in transition table
  GITHUB_ORIGIN_READONLY: "TASK_GITHUB_ORIGIN_READONLY", // 422 protected github field write
  EVENT_ARCHIVED: "TASK_EVENT_ARCHIVED", // 422 create/update under archived event
  REQUEST_NOT_FOUND: "TASK_REQUEST_NOT_FOUND", // 404 missing task request (send-receive)
} as const;

export const taskErrors = {
  notFound(id?: string): DubError {
    return new DubError(TaskErrorCodes.NOT_FOUND, id ? `Task not found: ${id}` : "Task not found", { status: 404 });
  },
  eventNotFound(eventId: string): DubError {
    return new DubError(TaskErrorCodes.EVENT_NOT_FOUND, `Event not found: ${eventId}`, {
      status: 404,
      details: { eventId },
    });
  },
  versionConflict(): DubError {
    return new DubError(TaskErrorCodes.VERSION_CONFLICT, "Version conflict (stale version)", { status: 409 });
  },
  dependencyCycle(details?: unknown): DubError {
    return new DubError(TaskErrorCodes.DEPENDENCY_CYCLE, "Dependency cycle detected", { status: 409, details });
  },
  invalidStatusTransition(from: string, to: string): DubError {
    return new DubError(TaskErrorCodes.INVALID_STATUS_TRANSITION, `Invalid status transition: ${from} -> ${to}`, {
      status: 409,
      details: { from, to },
    });
  },
  githubOriginReadonly(fields: string[]): DubError {
    return new DubError(TaskErrorCodes.GITHUB_ORIGIN_READONLY, "origin=github task: protected fields are read-only", {
      status: 422,
      details: { fields },
    });
  },
  eventArchived(eventId: string): DubError {
    return new DubError(TaskErrorCodes.EVENT_ARCHIVED, `Event is archived: ${eventId}`, {
      status: 422,
      details: { eventId },
    });
  },
  requestNotFound(id?: string): DubError {
    return new DubError(
      TaskErrorCodes.REQUEST_NOT_FOUND,
      id ? `Task request not found: ${id}` : "Task request not found",
      { status: 404 },
    );
  },
};
