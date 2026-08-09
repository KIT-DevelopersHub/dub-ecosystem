// Preference resolution: system defaults (code constants) + user overrides with
// longest-prefix-match conflict resolution (design §2/§3).
//
//   exact type  >  prefix "task.*"  >  "*"     (longer pattern wins)
//   same length →  override beats default
//
// The frozen @dub/types PreferenceEntry models this as { type, channels[] } where
// `channels` is the set of ENABLED channels for that type. Storage is the finer
// (user,type,channel,enabled) grain; we map between the two at the API boundary.
import type { PreferenceRow } from "./repo";
import type { NotificationChannel, NotificationPriority, NotificationType } from "./types";
import { CHANNELS } from "./config";

// System defaults (theme4 1-5, frozen):
//   in_app = on for all types EXCEPT chat.* (avoid double-count with FE6 unread)
//   email  = on only for urgent notifications
//   chat   = off
//   push   = on
export function defaultEnabled(
  type: NotificationType,
  channel: NotificationChannel,
  priority: NotificationPriority,
): boolean {
  switch (channel) {
    case "in_app":
      return !type.startsWith("chat.");
    case "email":
      return priority === "urgent";
    case "chat":
      return false;
    case "push":
      return true;
  }
}

// A type pattern is one of: "*", a prefix ending in ".", or an exact type string.
// Specificity: exact = Infinity, prefix = pattern length, "*" = -1.
function specificity(pattern: string): number {
  if (pattern === "*") return -1;
  if (pattern.endsWith(".")) return pattern.length;
  return Number.POSITIVE_INFINITY;
}

function matches(pattern: string, type: NotificationType): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".")) return type.startsWith(pattern);
  return pattern === type;
}

/**
 * Resolve the effective enabled flag for (type, channel) given the user's override
 * rows. The most specific matching override wins; absent any override, the system
 * default applies.
 */
export function resolveEnabled(
  overrides: PreferenceRow[],
  type: NotificationType,
  channel: NotificationChannel,
  priority: NotificationPriority,
): boolean {
  let best: { spec: number; enabled: boolean } | null = null;
  for (const row of overrides) {
    if (row.channel !== channel) continue;
    if (!matches(row.type, type)) continue;
    const spec = specificity(row.type);
    if (best === null || spec > best.spec) {
      best = { spec, enabled: row.enabled === 1 };
    }
  }
  if (best !== null) return best.enabled;
  return defaultEnabled(type, channel, priority);
}

// A pattern is stored under the exact key "task.*"; the DDL/`resolveEnabled` treat
// it as a prefix by its trailing dot. FE sends "task." style patterns; both the "*"
// wildcard and exact types are accepted. Anything else is rejected upstream.
export function isValidTypePattern(pattern: string): boolean {
  if (pattern === "*") return true;
  // exact ("task.assigned") or prefix ("task.") — dot-separated lowercase tokens,
  // optional trailing dot for the prefix form.
  return /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*\.?$/.test(pattern);
}

/**
 * Build the merged effective view as frozen PreferenceEntry[] — one entry per type
 * pattern present in defaults ("*") plus every type the user has overridden, listing
 * the channels that resolve to enabled for that pattern.
 */
export function mergedView(overrides: PreferenceRow[]): { type: NotificationType; channels: NotificationChannel[] }[] {
  const patterns = new Set<string>(["*"]);
  for (const row of overrides) patterns.add(row.type);
  const out: { type: NotificationType; channels: NotificationChannel[] }[] = [];
  for (const pattern of patterns) {
    // For the view, priority is unknown; report the normal-priority resolution.
    const enabled = CHANNELS.filter((ch) => resolveEnabled(overrides, viewType(pattern), ch, "normal"));
    out.push({ type: pattern, channels: enabled });
  }
  return out;
}

// For the merged view a prefix pattern is evaluated against a representative type so
// that prefix overrides are honoured (e.g. "task." -> evaluate as "task.").
function viewType(pattern: string): NotificationType {
  return pattern === "*" ? "" : pattern;
}
