// Contract enum guards — narrow `unknown` to the closed unions declared in
// @dub/types. Each allowed set is DERIVED from the @dub/types source of truth
// (TASK_STATUS_TRANSITIONS keys, PERMISSION_CATALOG keys) rather than re-typed, so
// a contract change in @dub/types can never silently drift from these validators.
import { identity, task } from "@dub/types";

// task-service state machine (D6) — keys of the frozen transition table are the
// exhaustive TaskStatus set; re-listing them would be a second source of truth.
const TASK_STATUSES: ReadonlySet<string> = new Set(
  Object.keys(task.TASK_STATUS_TRANSITIONS),
);
const TASK_PRIORITIES: ReadonlySet<string> = new Set<task.TaskPriority>([
  "low",
  "medium",
  "high",
  "urgent",
]);
const TASK_ORIGINS: ReadonlySet<string> = new Set<task.TaskOrigin>([
  "internal",
  "github",
]);

// RBAC catalog (theme2, 23 frozen keys) — derived straight from the catalog array.
const PERMISSION_KEYS: ReadonlySet<string> = new Set(
  identity.PERMISSION_CATALOG.map((e) => e.key),
);
const USER_STATUSES: ReadonlySet<string> = new Set<identity.UserStatus>([
  "active",
  "invited",
  "disabled",
  "rejected",
]);

// mail-gateway managed outbound providers (mail.SendMailResponse.provider union).
const MAIL_PROVIDERS: ReadonlySet<string> = new Set(["ses", "mailchannels", "resend"]);

export function isTaskStatus(v: unknown): v is task.TaskStatus {
  return typeof v === "string" && TASK_STATUSES.has(v);
}

export function isTaskPriority(v: unknown): v is task.TaskPriority {
  return typeof v === "string" && TASK_PRIORITIES.has(v);
}

export function isTaskOrigin(v: unknown): v is task.TaskOrigin {
  return typeof v === "string" && TASK_ORIGINS.has(v);
}

export function isPermissionKey(v: unknown): v is identity.PermissionKey {
  return typeof v === "string" && PERMISSION_KEYS.has(v);
}

export function isUserStatus(v: unknown): v is identity.UserStatus {
  return typeof v === "string" && USER_STATUSES.has(v);
}

export function isMailProvider(v: unknown): v is "ses" | "mailchannels" | "resend" {
  return typeof v === "string" && MAIL_PROVIDERS.has(v);
}

/**
 * True iff `to` is reachable from `from` per the frozen TASK_STATUS_TRANSITIONS
 * table (identity move `from === to` counts as allowed). Pure predicate: the 409
 * <SERVICE>_VERSION_CONFLICT / illegal-transition error stays the service's call.
 */
export function isTaskStatusTransitionAllowed(
  from: task.TaskStatus,
  to: task.TaskStatus,
): boolean {
  if (from === to) return true;
  return task.TASK_STATUS_TRANSITIONS[from].includes(to);
}

// Exposed for callers that want the raw sets (e.g. FieldCollector.requireEnum).
export const ENUM_SETS = {
  taskStatus: TASK_STATUSES,
  taskPriority: TASK_PRIORITIES,
  taskOrigin: TASK_ORIGINS,
  permissionKey: PERMISSION_KEYS,
  userStatus: USER_STATUSES,
  mailProvider: MAIL_PROVIDERS,
} as const;
