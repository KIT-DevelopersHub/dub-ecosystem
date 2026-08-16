// FE5-owned SPA routes + linkUrl resolution (FE5 §2-1, test 8, item 8-9).
// linkUrl targets are only valid if they resolve to a known route; unknown
// in-app paths fall back to the inbox.

export const ROUTE_INBOX = "/notifications";
export const ROUTE_PREFERENCES = "/settings/notifications";
export const ROUTE_MANAGE = "/notifications/manage";

// Permission keys guarding each route (FE5 §6).
export const PERM_INBOX = "notif:inbox:self";
export const PERM_PREFS = "notif:prefs:self";
// Admin-only: gates the Notification management screen (list admin notifications +
// publish to members). Held by admin + maintainer.
export const PERM_BROADCAST_PUBLISH = "notif:broadcast_publish";

// Route prefixes considered "known" for linkUrl navigation. A linkUrl is a
// concrete in-app path (e.g. "/tasks/task_123"); we accept any absolute in-app
// path but treat unparseable / off-site values as a fallback to the inbox.
const KNOWN_ROUTE_PREFIXES = ["/notifications", "/settings/notifications"];

// Additional in-app segment owners a notification may deep-link into. FE5 does
// not own these routes but they exist in the SPA route table; a linkUrl into
// one is honoured. (Kept conservative; extend as the SPA route table grows.)
const CROSS_UNIT_PREFIXES = ["/tasks", "/events", "/gantt", "/files"];

export interface LinkResolution {
  path: string; // where to navigate
  fellBack: boolean; // true if the original linkUrl was unknown/invalid
}

// Resolve a notification's linkUrl to a safe in-app navigation target.
// - null/empty -> no navigation (caller should not navigate)
// - external (http...) or non-absolute -> fallback to inbox
// - unknown in-app path -> fallback to inbox
export function resolveLinkUrl(linkUrl: string | null | undefined): LinkResolution | null {
  if (!linkUrl) return null; // test 8: linkUrl=null -> no navigation
  // Reject anything that isn't a same-origin absolute path.
  if (!linkUrl.startsWith("/") || linkUrl.startsWith("//")) {
    return { path: ROUTE_INBOX, fellBack: true };
  }
  const pathOnly = linkUrl.split(/[?#]/)[0] ?? linkUrl;
  const known =
    KNOWN_ROUTE_PREFIXES.some((p) => pathOnly === p || pathOnly.startsWith(p + "/")) ||
    CROSS_UNIT_PREFIXES.some((p) => pathOnly === p || pathOnly.startsWith(p + "/"));
  return known ? { path: linkUrl, fellBack: false } : { path: ROUTE_INBOX, fellBack: true };
}
