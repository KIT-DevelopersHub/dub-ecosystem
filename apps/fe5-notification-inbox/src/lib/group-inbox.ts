// Group inbox items by their notification group (app/type) so the list keeps a clear
// per-app separation instead of one flat stream. Pure + deterministic: sections come out
// in NOTIFICATION_GROUP_ORDER, items keep their incoming (server, newest-first) order
// within each section, and empty sections are dropped. Unread counts are precomputed for
// the section header emphasis.

import type { InboxItem } from "../contracts/notification-api";
import {
  resolveTypeDisplay,
  NOTIFICATION_GROUP_ORDER,
  NOTIFICATION_GROUP_META,
  type NotificationGroup,
} from "./type-dictionary";

export interface InboxGroup {
  group: NotificationGroup;
  label: string;
  icon: string;
  items: InboxItem[];
  unread: number;
}

export function groupInboxItems(items: InboxItem[]): InboxGroup[] {
  const buckets = new Map<NotificationGroup, InboxItem[]>();
  for (const item of items) {
    const { group } = resolveTypeDisplay(item.type);
    const bucket = buckets.get(group);
    if (bucket) bucket.push(item);
    else buckets.set(group, [item]);
  }
  const out: InboxGroup[] = [];
  for (const group of NOTIFICATION_GROUP_ORDER) {
    const groupItems = buckets.get(group);
    if (!groupItems || groupItems.length === 0) continue;
    const meta = NOTIFICATION_GROUP_META[group];
    out.push({
      group,
      label: meta.label,
      icon: meta.icon,
      items: groupItems,
      unread: groupItems.reduce((n, i) => (i.readAt === null ? n + 1 : n), 0),
    });
  }
  return out;
}
