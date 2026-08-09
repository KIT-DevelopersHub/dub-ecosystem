// task-service body validators (CreateTaskRequest / UpdateTaskRequest), built on
// the FieldCollector + contract enum guards. Field bounds mirror the task-service
// contract (title 1..200; status/priority/origin from the frozen unions).
import { invalidField, FieldCollector } from "./collector";
import { ENUM_SETS } from "./guards";
import { isPlainObject, isString } from "./primitives";
import type { task } from "@dub/types";

const TITLE_MAX = 200;

/** null | undefined | string — the shape of the nullable-string patch fields. */
function checkNullableString(c: FieldCollector, field: string, v: unknown): void {
  if (v === undefined || v === null) return;
  if (!isString(v)) c.add(field, "invalid_type", `${field} must be a string or null`);
}

/**
 * Validate a POST /tasks body. Throws VALIDATION_FAILED with every field error.
 * `origin` is shape-validated only; the "service-role-only" authorization of
 * origin=github stays a service concern (this package never sees the caller role).
 */
export function validateCreateTaskRequest(body: unknown): task.CreateTaskRequest {
  if (!isPlainObject(body)) throw invalidField("(root)", "invalid_type");
  const c = new FieldCollector();

  c.requireNonEmptyString("eventId", body.eventId);
  c.requireNonEmptyString("title", body.title, TITLE_MAX);
  c.optionalString("description", body.description);
  c.optionalEnum("priority", body.priority, ENUM_SETS.taskPriority);
  c.optionalString("assigneeId", body.assigneeId);
  if (body.dueAt !== undefined && !isString(body.dueAt)) {
    c.add("dueAt", "invalid_type", "dueAt must be an ISO8601 string");
  }
  c.optionalEnum("origin", body.origin, ENUM_SETS.taskOrigin);

  c.throwIfInvalid();
  return body as unknown as task.CreateTaskRequest;
}

/**
 * Validate a PATCH /tasks/:id body. `version` (optimistic lock, D4) is required;
 * nullable patch fields (description / assigneeId / dueAt) accept explicit null.
 */
export function validateUpdateTaskRequest(body: unknown): task.UpdateTaskRequest {
  if (!isPlainObject(body)) throw invalidField("(root)", "invalid_type");
  const c = new FieldCollector();

  c.optionalInteger("version", body.version, { min: 0 });
  if (body.version === undefined) c.add("version", "required");

  c.optionalString("title", body.title, { min: 1, max: TITLE_MAX });
  checkNullableString(c, "description", body.description);
  c.optionalEnum("status", body.status, ENUM_SETS.taskStatus);
  c.optionalEnum("priority", body.priority, ENUM_SETS.taskPriority);
  checkNullableString(c, "assigneeId", body.assigneeId);
  checkNullableString(c, "dueAt", body.dueAt);

  c.throwIfInvalid();
  return body as unknown as task.UpdateTaskRequest;
}
