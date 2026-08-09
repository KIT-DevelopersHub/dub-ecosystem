// Pure field mapping between task-service tasks and GitHub issues. No I/O.
// Frozen by the P0a design (theme3 D6 status写像). task-service has no label field,
// so labels are a GitHub-side concern: user labels are preserved untouched and the
// task status is carried by issue.state plus a `status:*` marker for the 3 values
// that open/closed cannot express (in_progress / blocked / cancelled).
import type { task } from "@dub/types";
import type { IssueSnapshot, TaskSnapshot } from "./types";

export type TaskStatus = task.TaskStatus;

const STATUS_LABEL_PREFIX = "status:";
const DEGRADE_TO_STATE: Record<TaskStatus, "open" | "closed"> = {
  todo: "open",
  in_progress: "open",
  blocked: "open",
  done: "closed",
  cancelled: "closed",
};
// Statuses fully expressed by issue.state alone (no status:* marker needed).
const PLAIN_STATE_STATUS: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["todo", "done"]);

export function statusToState(status: TaskStatus): "open" | "closed" {
  return DEGRADE_TO_STATE[status];
}

/** The status:* marker for a status, or null when state alone suffices. */
export function statusLabel(status: TaskStatus): string | null {
  return PLAIN_STATE_STATUS.has(status) ? null : `${STATUS_LABEL_PREFIX}${status}`;
}

/** Recover a task status from an issue's state + status:* marker (github->internal). */
export function stateToStatus(state: "open" | "closed", labels: string[]): TaskStatus {
  const marker = labels.map((l) => l.toLowerCase()).find((l) => l.startsWith(STATUS_LABEL_PREFIX));
  if (marker) {
    const raw = marker.slice(STATUS_LABEL_PREFIX.length);
    if (isTaskStatus(raw) && DEGRADE_TO_STATE[raw] === state) return raw;
  }
  return state === "open" ? "todo" : "done";
}

export function isTaskStatus(v: string): v is TaskStatus {
  return v === "todo" || v === "in_progress" || v === "blocked" || v === "done" || v === "cancelled";
}

/** Drop the internal status:* marker, leaving user-facing labels. */
export function userLabels(labels: string[]): string[] {
  return dedupe(labels.filter((l) => !l.toLowerCase().startsWith(STATUS_LABEL_PREFIX)));
}

/**
 * The label set an issue should carry for a given task status: the issue's
 * existing user labels plus the (single) status:* marker if required.
 */
export function issueLabelsForStatus(status: TaskStatus, existingIssueLabels: string[]): string[] {
  const base = userLabels(existingIssueLabels);
  const marker = statusLabel(status);
  return marker ? dedupe([...base, marker]) : dedupe(base);
}

// ---- diff helpers (conflict detection + minimal writes) ----

export interface FieldDiff {
  title: boolean;
  description: boolean;
  status: boolean;
}

/** Which logical fields differ between a task and its linked issue. */
export function diffTaskVsIssue(t: TaskSnapshot, issue: IssueSnapshot): FieldDiff {
  return {
    title: t.title !== issue.title,
    description: (t.description ?? "") !== (issue.body ?? ""),
    status: statusToState(t.status) !== issue.state || stateToStatus(issue.state, issue.labels) !== t.status,
  };
}

export function divergedFieldNames(d: FieldDiff): string[] {
  const out: string[] = [];
  if (d.title) out.push("title");
  if (d.description) out.push("description");
  if (d.status) out.push("status");
  return out;
}

export function hasAnyDiff(d: FieldDiff): boolean {
  return d.title || d.description || d.status;
}

export function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** True if the issue carries at least one of the filter labels (empty filter = match all). */
export function matchesLabelFilter(issueLabels: string[], filter: string[]): boolean {
  if (filter.length === 0) return true;
  const set = new Set(issueLabels.map((l) => l.toLowerCase()));
  return filter.some((f) => set.has(f.toLowerCase()));
}
