// Group inbox items by their notification CATEGORY (アプリアップデート / メール / 参加届 / その他)
// so the list keeps a clear per-category separation instead of one flat stream and stays aligned
// with the filter tabs. Pure + deterministic: sections come out in NOTIFICATION_CATEGORY_ORDER,
// items keep their incoming (server, newest-first) order within each section, empty sections are
// dropped, and unread counts are precomputed for the section header emphasis.

import type { InboxItem } from "../contracts/notification-api";
import {
  resolveCategory,
  NOTIFICATION_CATEGORY_ORDER,
  NOTIFICATION_CATEGORY_META,
  type NotificationCategory,
} from "./type-dictionary";

export interface InboxGroup {
  group: NotificationCategory;
  label: string;
  icon: string;
  items: InboxItem[];
  unread: number;
}

export function groupInboxItems(items: InboxItem[]): InboxGroup[] {
  const buckets = new Map<NotificationCategory, InboxItem[]>();
  for (const item of items) {
    const category = resolveCategory(item.type);
    const bucket = buckets.get(category);
    if (bucket) bucket.push(item);
    else buckets.set(category, [item]);
  }
  const out: InboxGroup[] = [];
  for (const category of NOTIFICATION_CATEGORY_ORDER) {
    const groupItems = buckets.get(category);
    if (!groupItems || groupItems.length === 0) continue;
    const meta = NOTIFICATION_CATEGORY_META[category];
    out.push({
      group: category,
      label: meta.label,
      icon: meta.icon,
      items: groupItems,
      unread: groupItems.reduce((n, i) => (i.readAt === null ? n + 1 : n), 0),
    });
  }
  return out;
}
