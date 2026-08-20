// Notification type display dictionary (FE5-internal constant, not a contract).
// Maps NotificationType -> { label, icon (FE1 IconName), group } by longest
// match. Unknown types fall back to the raw string + a generic icon (test 13:
// must never crash).

import type { BadgeTone, IconName } from "@dub/ui";
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
  // Admin-facing operational types (Notification管理). Grouped under システム so the genre
  // filter classifies them without a new group; explicit patterns give a readable label
  // instead of the raw machine name.
  { pattern: "deploy.*", label: "デプロイ", icon: "info", group: "system" },
  { pattern: "feedback", label: "フィードバック", icon: "alert", group: "system" },
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

// Display order + section metadata for the grouped inbox. Notifications keep their
// per-app separation (one section per group) so the list never flattens into an
// undifferentiated stream. 新機能 (release) leads because it is the highest-signal.
export const NOTIFICATION_GROUP_ORDER: NotificationGroup[] = ["release", "task", "event", "system"];

export const NOTIFICATION_GROUP_META: Record<NotificationGroup, { label: string; icon: IconName }> = {
  release: { label: "新機能", icon: "megaphone" },
  task: { label: "タスク", icon: "task" },
  event: { label: "イベント", icon: "calendar" },
  system: { label: "システム", icon: "info" },
};

// ---------------------------------------------------------------------------
// Notification CATEGORY (the user-facing inbox tabs + per-card label). This is the
// SINGLE SOURCE OF TRUTH for the server-`type` → category mapping (判断: dub-api-contract-sot):
// the filter bar tabs, the client-side tab filtering, the list section grouping, and the
// card badge all derive from the constants below — never re-declared elsewhere. Keyed on the
// notification `type` string produced by the services:
//   - 参加届 (participation) = member.participation.*  (member-service participationNotify)
//   - メール (mail)          = mail.*                  (mail-gateway / mail-automation)
//   - アプリアップデート     = deploy.* + release/release.*  (deploy admin notifications + release notes)
//   - その他 (other)         = everything else (tasks/events/system/…): shown only under "All"
// The taxonomy is intentionally separate from NotificationGroup above (which stays the
// per-app display grouping used by preferences + the type dictionary). Categories are what the
// user asked the tabs to reflect.
export type NotificationCategory = "app_update" | "mail" | "participation" | "other";

// The tab selector value: a concrete category or "all" (no filtering).
export type CategoryFilter = NotificationCategory | "all";

// Ordered prefix rules. `match` matches a type when it equals `match` OR starts with
// `match + "."` — so "release" matches "release" and "release.notes" but NOT "released.x".
// First match wins; order the more specific prefixes first if they ever overlap.
const CATEGORY_RULES: { match: string; category: NotificationCategory }[] = [
  { match: "member.participation", category: "participation" },
  { match: "mail", category: "mail" },
  { match: "deploy", category: "app_update" },
  { match: "release", category: "app_update" },
];

function ruleMatches(match: string, type: string): boolean {
  return type === match || type.startsWith(`${match}.`);
}

// Resolve a concrete notification type to its category (the tab/badge taxonomy).
export function resolveCategory(type: NotificationType): NotificationCategory {
  for (const rule of CATEGORY_RULES) {
    if (ruleMatches(rule.match, type)) return rule.category;
  }
  return "other";
}

export interface NotificationCategoryMeta {
  label: string;
  icon: IconName;
  tone: BadgeTone; // @dub/ui Badge tone → color of the per-card label
}

// Display metadata for each category: the section header + the colored card badge.
export const NOTIFICATION_CATEGORY_META: Record<NotificationCategory, NotificationCategoryMeta> = {
  app_update: { label: "アプリアップデート", icon: "megaphone", tone: "brand" },
  mail: { label: "メール", icon: "at-sign", tone: "info" },
  participation: { label: "参加届", icon: "user", tone: "success" },
  other: { label: "その他", icon: "bell", tone: "neutral" },
};

// Section display order for the grouped inbox (highest-signal first). "other" is last.
export const NOTIFICATION_CATEGORY_ORDER: NotificationCategory[] = [
  "app_update",
  "mail",
  "participation",
  "other",
];

// The inbox filter-bar tabs: "All" + the three named categories. "other" is intentionally
// NOT a tab — unclassified notifications appear only under "All" (per the design ask).
export const NOTIFICATION_CATEGORY_TABS: { id: CategoryFilter; label: string }[] = [
  { id: "all", label: "すべて" },
  { id: "app_update", label: NOTIFICATION_CATEGORY_META.app_update.label },
  { id: "mail", label: NOTIFICATION_CATEGORY_META.mail.label },
  { id: "participation", label: NOTIFICATION_CATEGORY_META.participation.label },
];

// True when an item belongs to the active tab. "all" matches everything.
export function matchesCategoryFilter(type: NotificationType, filter: CategoryFilter): boolean {
  return filter === "all" || resolveCategory(type) === filter;
}
