// Presentation mapping for a task's status → calendar chip colors + a JA label.
// Colors reference @dub/tokens CSS vars so light/dark stay consistent. Kept small
// and dependency-free so it can be unit-tested and reused by month/week views.
import type { task } from "@dub/types";

export interface StatusVisual {
  label: string;
  /** chip background */
  bg: string;
  /** chip text/border accent */
  fg: string;
  /** status dot color */
  dot: string;
}

const STATUS_VISUALS: Record<task.TaskStatus, StatusVisual> = {
  todo: {
    label: "未着手",
    bg: "var(--dub-color-surface-sunken, #f1f3f5)",
    fg: "var(--dub-color-text-secondary, #444)",
    dot: "var(--dub-color-text-muted, #888)",
  },
  in_progress: {
    label: "進行中",
    bg: "var(--dub-color-brand-50, #eef2ff)",
    fg: "var(--dub-color-brand-600, #3b46c4)",
    dot: "var(--dub-color-brand-500, #4f46e5)",
  },
  blocked: {
    label: "ブロック",
    bg: "var(--dub-color-warning-50, #fff7e6)",
    fg: "var(--dub-color-warning-600, #b7791f)",
    dot: "var(--dub-color-warning-500, #d69e2e)",
  },
  done: {
    label: "完了",
    bg: "var(--dub-color-success-50, #e9f8ef)",
    fg: "var(--dub-color-success-600, #2f855a)",
    dot: "var(--dub-color-success-500, #38a169)",
  },
  cancelled: {
    label: "中止",
    bg: "var(--dub-color-surface-sunken, #f1f3f5)",
    fg: "var(--dub-color-text-muted, #888)",
    dot: "var(--dub-color-text-muted, #888)",
  },
};

export function statusVisual(status: task.TaskStatus): StatusVisual {
  return STATUS_VISUALS[status] ?? STATUS_VISUALS.todo;
}

/** All statuses in a stable order (legend rendering). */
export const STATUS_ORDER: readonly task.TaskStatus[] = [
  "todo",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
];
