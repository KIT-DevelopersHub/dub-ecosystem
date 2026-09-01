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

/**
 * Canonical date-field labels — single source of truth for BOTH create forms
 * (タスク発行 / タスク作成) and the detail panel, so the task app and the gantt
 * never drift apart again. The domain field stays `dueAt` (API contract); the
 * user-facing label is 「終了日」(期日=終了日として扱う・二重定義禁止).
 */
export const DATE_LABEL = {
  start: "開始日",
  /** dueAt / endsAt の表示名。旧「期日」「期限」を「終了日」に統一。 */
  end: "終了日",
} as const;

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
