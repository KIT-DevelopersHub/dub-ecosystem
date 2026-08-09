// notificationsModule — the single FeatureModule FE5 registers into the SPA
// shell (FE2). One object: routes (lazy, code-split), nav (badgeSource wired to
// the shared unread store), headerWidget (the bell), requiredPermissions.

import type { ComponentType } from "react";
import type { FeatureModule } from "./contracts/fe2";
import {
  PERM_INBOX,
  PERM_PREFS,
  ROUTE_INBOX,
  ROUTE_PREFERENCES,
} from "./lib/routes";
import { getUnreadCount } from "./store/unread-store";
import NotificationBell from "./components/NotificationBell";

export const notificationsModule: FeatureModule = {
  id: "notifications",
  routes: [
    {
      path: ROUTE_INBOX,
      component: () =>
        import("./components/NotificationInboxPage").then((m) => ({
          default: m.default as ComponentType,
        })),
      requiredPermissions: [PERM_INBOX],
    },
    {
      path: ROUTE_PREFERENCES,
      component: () =>
        import("./components/NotificationPreferencesPage").then((m) => ({
          default: m.default as ComponentType,
        })),
      requiredPermissions: [PERM_PREFS],
    },
  ],
  nav: [
    {
      id: "notifications",
      label: "Notifications",
      to: ROUTE_INBOX,
      icon: "bell",
      requiredPermissions: [PERM_INBOX],
      // Single source of truth: the shell reads this, never polls itself.
      badgeSource: getUnreadCount,
    },
  ],
  headerWidget: NotificationBell as ComponentType,
  requiredPermissions: [PERM_INBOX],
};

export default notificationsModule;
