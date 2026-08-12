// Notification type display dictionary (FE5-internal constant, not a contract).
// Maps NotificationType -> { label, icon (FE1 IconName), group } by longest
// match. Unknown types fall back to the raw string + a generic icon (test 13:
// must never crash).

import type { IconName } from "@dub/ui";
import type { NotificationType } from "../contracts/notification-api";
import { matchSpecificity } from "./preference-merge";

export type NotificationGroup = "task" | "event" | "system" | "release";

export interface NotificationTypeDisplay {
  pattern: string; // "task.assigned" | "task.*" | "*"
  label: string;
  icon: IconName;
  group: NotificationGroup;
}

// Ordered most-generic-first; resolution picks the longest match regardless of
// array order, but keeping it readable helps maintenance.
export const NOTIFICATION_TYPE_DISPLAY: NotificationTypeDisplay[] = [
  { pattern: "*", label: "Notification", icon: "info", group: "system" },
  { pattern: "task.*", label: "Task", icon: "task", group: "task" },
  { pattern: "task.assigned", label: "Task assigned to you", icon: "task", group: "task" },
  { pattern: "task.due_soon", label: "Task due soon", icon: "alert", group: "task" },
  { pattern: "task.completed", label: "Task completed", icon: "check", group: "task" },
  { pattern: "event.*", label: "Event", icon: "calendar", group: "event" },
  { pattern: "event.invited", label: "Event invitation", icon: "calendar", group: "event" },
  { pattern: "event.reminder", label: "Event reminder", icon: "calendar", group: "event" },
  { pattern: "system.*", label: "System", icon: "info", group: "system" },
  { pattern: "system.announcement", label: "Announcement", icon: "megaphone", group: "system" },
  // Release notes (new-feature announcements). Its own group so it gets a dedicated
  // "新機能" filter chip and a distinct 🎉 badge in the inbox.
  { pattern: "release", label: "🎉 新機能", icon: "megaphone", group: "release" },
  { pattern: "release.*", label: "🎉 新機能", icon: "megaphone", group: "release" },
];

const GENERIC_ICON: IconName = "bell";

export interface ResolvedTypeDisplay {
  label: string;
  icon: IconName;
  group: NotificationGroup;
  known: boolean;
}

// Resolve a concrete type to its display metadata by longest match.
export function resolveTypeDisplay(type: NotificationType): ResolvedTypeDisplay {
  let best: { spec: number; entry: NotificationTypeDisplay } | null = null;
  for (const entry of NOTIFICATION_TYPE_DISPLAY) {
    const spec = matchSpecificity(entry.pattern, type);
    if (spec < 0) continue;
    if (best === null || spec > best.spec) best = { spec, entry };
  }
  if (!best) {
    // No "*" fallback configured (shouldn't happen) -> raw string, generic icon.
    return { label: type, icon: GENERIC_ICON, group: "system", known: false };
  }
  // A hit on the bare "*" catch-all counts as "unknown" for display purposes:
  // show the raw type string so the operator sees the machine name (test 13).
  const isCatchAll = best.entry.pattern === "*";
  return {
    label: isCatchAll ? type : best.entry.label,
    icon: isCatchAll ? GENERIC_ICON : best.entry.icon,
    group: best.entry.group,
    known: !isCatchAll,
  };
}

// The prefix-group filter options for the inbox filter bar (test 3).
export const NOTIFICATION_GROUP_PREFIXES: { group: NotificationGroup; prefix: string; label: string }[] = [
  { group: "release", prefix: "release", label: "新機能" },
  { group: "task", prefix: "task.", label: "Tasks" },
  { group: "event", prefix: "event.", label: "Events" },
  { group: "system", prefix: "system.", label: "System" },
];
