// Status → event color + JA label. Each status acts like one of Google Calendar's
// "マイカレンダー" (its own color, toggled from the sidebar). Colors are Google's
// event palette (ピーコック/ブルーベリー/ミカン/セージ/グラファイト) so blocks read the
// way users already know; text on them is always white, as in Google.
import type { task } from "@dub/types";

export interface StatusVisual {
  label: string;
  /** solid event color (block / bar / dot / sidebar checkbox) */
  color: string;
}

const STATUS_VISUALS: Record<task.TaskStatus, StatusVisual> = {
  todo: { label: "未着手", color: "#039be5" },
  in_progress: { label: "進行中", color: "#3f51b5" },
  blocked: { label: "ブロック", color: "#f4511e" },
  done: { label: "完了", color: "#33b679" },
  cancelled: { label: "中止", color: "#616161" },
};

export function statusVisual(status: task.TaskStatus): StatusVisual {
  return STATUS_VISUALS[status] ?? STATUS_VISUALS.todo;
}

/** All statuses in a stable order (sidebar rendering). */
export const STATUS_ORDER: readonly task.TaskStatus[] = ["todo", "in_progress", "blocked", "done", "cancelled"];

export const PRIORITY_LABEL: Record<task.TaskPriority, string> = {
  low: "低",
  medium: "中",
  high: "高",
  urgent: "緊急",
};
