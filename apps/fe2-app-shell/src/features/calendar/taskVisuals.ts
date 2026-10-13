// Status → event color + JA label. Each status acts like one of Google Calendar's
// "マイカレンダー" (its own color, toggled from the sidebar). Colors are Google's
// event palette (ピーコック/ブルーベリー/ミカン/セージ/グラファイト) so blocks read the
// way users already know; text on them is always white, as in Google.
import type { identity, task } from "@dub/types";
import { PERSONAL_LABEL, isMeetingTask, isVacationTask, labelOf } from "./calendar-model";

export const UNTITLED_TITLE = "（タイトルなし）";

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

/** 休暇 gets its own calendar color (Google's グレープ), whatever its status. */
export const VACATION_VISUAL: StatusVisual = { label: "休暇", color: "#8e24aa" };

/** ミーティング (shared-account Google Calendar events) — Google の バジル (no status uses it). */
export const MEETING_VISUAL: StatusVisual = { label: "ミーティング", color: "#0b8043" };

/** Color/label for a drawn item: ミーティング, 休暇, else its status. */
export function itemVisual(t: task.Task): StatusVisual {
  if (isMeetingTask(t)) return MEETING_VISUAL;
  return isVacationTask(t) ? VACATION_VISUAL : statusVisual(t.status);
}

// ── ラベル ──────────────────────────────────────────────────────────────────
// 予定のラベル = 「個人」+ the org's roles. Not managed by hand: a role added in
// ロール管理 shows up here on the next load.

export interface CalendarLabel {
  /** PERSONAL_LABEL or a role id */
  key: string;
  name: string;
}

export const PERSONAL_LABEL_ENTRY: CalendarLabel = { key: PERSONAL_LABEL, name: "個人" };

export function buildLabels(roles: readonly Pick<identity.Role, "id" | "name">[]): CalendarLabel[] {
  return [PERSONAL_LABEL_ENTRY, ...roles.map((r) => ({ key: r.id, name: r.name }))];
}

/** The label for a key; an unknown key (deleted role) falls back to 個人. */
export function resolveLabel(labels: readonly CalendarLabel[], key: string): CalendarLabel {
  return labels.find((l) => l.key === key) ?? PERSONAL_LABEL_ENTRY;
}

/** Who a 予定 belongs to: the role for a labelled one, else the person (担当, or 依頼者). */
export function ownerOf(
  t: task.Task,
  labels: readonly CalendarLabel[],
  names: ReadonlyMap<string, string>,
): string | null {
  const label = resolveLabel(labels, labelOf(t));
  if (label.key !== PERSONAL_LABEL) return label.name;
  const person = t.assigneeId ?? t.createdBy;
  return (person && names.get(person)) || null;
}

/** "<owner>：<title>" so a month grid shows whose 予定/休暇 it is at a glance. */
export function ownedTitle(t: task.Task, owner: string | null): string {
  const title = t.title || UNTITLED_TITLE;
  return owner ? `${owner}：${title}` : title;
}
