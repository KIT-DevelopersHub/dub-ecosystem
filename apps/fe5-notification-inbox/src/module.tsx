// notificationsModule — the single FeatureModule FE5 registers into the SPA
// shell (FE2). One object: routes (lazy, code-split), nav (badgeSource wired to
// the shared unread store), headerWidget (the bell), requiredPermissions.

import type { ComponentType } from "react";
import type { FeatureModule } from "./contracts/fe2";
import {
  PERM_INBOX,
  PERM_PREFS,
  PERM_BROADCAST_PUBLISH,
  ROUTE_INBOX,
  ROUTE_PREFERENCES,
  ROUTE_MANAGE,
} from "./lib/routes";
import { useUnreadBadge } from "./store/unread-store";
import NotificationBell from "./components/NotificationBell";

export const notificationsModule: FeatureModule = {
  id: "notifications",
  routes: [
    {
      path: ROUTE_INBOX,
      // Frozen shell shape: lazy loader resolving to `{ Component }`.
      lazy: () =>
        import("./components/NotificationInboxPage").then((m) => ({
          Component: m.default as ComponentType,
        })),
      auth: "required",
      requiredPermissions: [PERM_INBOX],
    },
    {
      path: ROUTE_PREFERENCES,
      lazy: () =>
        import("./components/NotificationPreferencesPage").then((m) => ({
          Component: m.default as ComponentType,
        })),
      auth: "required",
      requiredPermissions: [PERM_PREFS],
    },
    {
      // Admin-only Notification management (list admin notifications + publish to
      // members). The shell ANDs the module perm (notif:inbox:self) with this route perm,
      // so only admins/maintainers (holding notif:broadcast_publish) can open it.
      path: ROUTE_MANAGE,
      lazy: () =>
        import("./components/NotificationManagePage").then((m) => ({
          Component: m.default as ComponentType,
        })),
      auth: "required",
      requiredPermissions: [PERM_BROADCAST_PUBLISH],
    },
  ],
  nav: [
    {
      label: "Notifications",
      path: ROUTE_INBOX,
      icon: "bell",
      // events(10) < tasks(20) < notifications(30) < chat(40) < admin(50).
      order: 30,
      // Single source of truth: the shell reads this, never polls itself. A
      // subscribing hook (not a one-shot read) so the 9-dot launcher tile badge
      // re-renders with the bell whenever the shared unread count changes (A04).
      badgeSource: useUnreadBadge,
    },
  ],
  headerWidget: NotificationBell as ComponentType,
};

export default notificationsModule;
