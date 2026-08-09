// Input validation + status-transition checks.
//
// Dependency-cycle / unknown-ref detection is NOT here: it lives in the single
// @dub/gantt-calc `validateDependencies` pure function that app.ts imports
// (task-service.md §1/§5 — HTTP /validate removed, engine unified). The former
// local DFS was deleted to end the two-engine duplication.
import { errors, type FieldError } from "@dub/errors";
import { task } from "@dub/types";
import { taskErrors } from "./errors";

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const PRIORITIES: ReadonlySet<string> = new Set(["low", "medium", "high", "urgent"]);
const STATUSES: ReadonlySet<string> = new Set(["todo", "in_progress", "blocked", "done", "cancelled"]);

// origin=github protected fields (task-service.md §6 + P0b 凍結: 保護6項目):
// edited only by service role. priority is protected (github-sync owns it).
export const PROTECTED_ORIGIN_FIELDS: readonly string[] = [
  "title",
  "description",
  "status",
  "priority",
  "assigneeId",
  "dueAt",
];

export function assertValid(fieldErrors: FieldError[]): void {
  if (fieldErrors.length > 0) throw errors.validationFailed(fieldErrors);
}

export function checkTitle(title: unknown, out: FieldError[]): void {
  if (typeof title !== "string" || title.length < 1 || title.length > 200) {
    out.push({ field: "title", reason: title === undefined ? "required" : "too_long", message: "title must be 1..200 chars" });
  }
}

export function checkIso(value: unknown, field: string, out: FieldError[]): void {
  if (value === null || value === undefined) return;
  if (typeof value !== "string" || !ISO_RE.test(value)) {
    out.push({ field, reason: "invalid_format", message: `${field} must be ISO8601 UTC` });
  }
}

export function checkPriority(value: unknown, out: FieldError[]): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !PRIORITIES.has(value)) {
    out.push({ field: "priority", reason: "invalid_enum" });
  }
}

export function checkStatusValue(value: unknown, out: FieldError[]): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !STATUSES.has(value)) {
    out.push({ field: "status", reason: "invalid_enum" });
  }
}

/** limit default 50, max 200 (common CursorQuery D3). Throws VALIDATION_FAILED on >200. */
export function normalizeLimit(raw: string | undefined): number {
  if (raw === undefined) return 50;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 50;
  if (n > 200) throw errors.validationFailed([{ field: "limit", reason: "too_large", message: "limit max is 200" }]);
  return n;
}

/** Validate a status transition against the frozen table; throws 409 on illegal move. */
export function assertStatusTransition(from: task.TaskStatus, to: task.TaskStatus): void {
  if (from === to) return;
  const allowed = task.TASK_STATUS_TRANSITIONS[from];
  if (!allowed.includes(to)) throw taskErrors.invalidStatusTransition(from, to);
}
