// Shared presentation + date helpers for the create modal and detail panel.
import type { common, task } from "@dub/types";

export const STATUS_LABEL: Record<task.TaskStatus, string> = {
  todo: "未着手",
  in_progress: "進行中",
  blocked: "ブロック",
  done: "完了",
  cancelled: "中止",
};

export const PRIORITY_LABEL: Record<task.TaskPriority, string> = {
  low: "低",
  medium: "中",
  high: "高",
  urgent: "緊急",
};

/** <input type="date"> value (yyyy-mm-dd) -> ISODateTime at UTC midnight, or null. */
export function isoFromDateInput(date: string | null): common.ISODateTime | null {
  if (!date) return null;
  return `${date}T00:00:00.000Z`;
}

/** ISODateTime -> <input type="date"> value (yyyy-mm-dd), or null. */
export function dateInputFromIso(iso: common.ISODateTime | null): string | null {
  if (!iso) return null;
  return iso.slice(0, 10);
}
