// Notification management — genre (category) filtering + selection helpers. Pure &
// framework-free so the page stays thin and the logic is unit-tested directly.
//
// Categories reuse the existing notification classification (lib/type-dictionary): every
// admin notification's `type` resolves to a NotificationGroup (release / task / event /
// system), labelled 新機能 / タスク / イベント / システム. The filter offers "すべて" plus
// only the categories actually present, so no empty tabs appear.

import type { AdminNotificationItem } from "../contracts/notification-api";
import {
  resolveTypeDisplay,
  NOTIFICATION_GROUP_ORDER,
  NOTIFICATION_GROUP_META,
  type NotificationGroup,
} from "./type-dictionary";

export type ManageCategory = NotificationGroup;
/** null == the "すべて" (all) filter. */
export type ManageFilter = ManageCategory | null;

/** The genre a given admin notification belongs to. */
export function categoryOf(item: AdminNotificationItem): ManageCategory {
  return resolveTypeDisplay(item.type).group;
}

export interface CategoryOption {
  value: ManageCategory;
  label: string;
  count: number;
}

/** Categories present in the list (ordered, with counts) — drives the filter tabs. */
export function availableCategories(items: AdminNotificationItem[]): CategoryOption[] {
  const counts = new Map<ManageCategory, number>();
  for (const it of items) {
    const g = categoryOf(it);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return NOTIFICATION_GROUP_ORDER.filter((g) => counts.has(g)).map((g) => ({
    value: g,
    label: NOTIFICATION_GROUP_META[g].label,
    count: counts.get(g) ?? 0,
  }));
}

/** Items visible under the active filter (null == all). */
export function filterByCategory(items: AdminNotificationItem[], filter: ManageFilter): AdminNotificationItem[] {
  if (filter === null) return items;
  return items.filter((it) => categoryOf(it) === filter);
}

/** Ids in `items` that can still be published (not already published). */
export function publishableIds(items: AdminNotificationItem[]): string[] {
  return items.filter((it) => it.publishedBroadcastId === null).map((it) => it.id);
}

/** True when every publishable item in `items` is selected (drives the select-all state).
 *  False when there is nothing publishable (so the select-all is not shown as "checked"). */
export function allPublishableSelected(items: AdminNotificationItem[], selected: ReadonlySet<string>): boolean {
  const ids = publishableIds(items);
  return ids.length > 0 && ids.every((id) => selected.has(id));
}
