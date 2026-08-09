// FE3 FeatureModule (id="events"). FE2 mounts this into the app shell and owns the
// router; FE3 declares its segment-owned routes (lazy-loaded per FE2's real
// contract), a nav entry, and the org-wide permissions each route requires. The
// ActionTypeRegistry is a module-level singleton reachable from the package public
// export (src/index.ts) so FE4 (taskActionPlugin) / FE6 register plugins into it
// at FE2 app init.
import type { FeatureModule } from "./contracts/fe2";
import { createActionTypeRegistry } from "./registry/ActionTypeRegistry";
import { genericActionPlugin } from "./components/GenericActionPanel";
import { routePaths } from "./lib/routes";

/** App-global registry; GenericActionPanel is the mandatory fallback. */
export const actionTypeRegistry = createActionTypeRegistry(genericActionPlugin);

export const eventFeatureModule: FeatureModule = {
  id: "events",
  requiredPermissions: ["event:read"], // module-level; fail-closed while /me loading
  nav: [
    {
      label: "イベント",
      path: routePaths.list,
      icon: "calendar",
      order: 20,
    },
  ],
  routes: [
    {
      path: routePaths.list,
      lazy: () => import("./pages/EventListPage").then((m) => ({ Component: m.EventListPage })),
      auth: "required",
      requiredPermissions: ["event:read"],
    },
    {
      path: routePaths.detail,
      lazy: () => import("./pages/EventDetailPage").then((m) => ({ Component: m.EventDetailPage })),
      auth: "required",
      requiredPermissions: ["event:read"],
      // FE4 nests the /events/:eventId/tasks route here via `children` at
      // integration (cross-PR: apps/fe4-task-gantt, unmerged). FE3 owns no tasks body.
    },
    {
      path: routePaths.action,
      lazy: () => import("./pages/ActionDetailPage").then((m) => ({ Component: m.ActionDetailPage })),
      auth: "required",
      requiredPermissions: ["event:read"],
    },
    {
      path: routePaths.settings,
      lazy: () => import("./pages/EventSettingsPage").then((m) => ({ Component: m.EventSettingsPage })),
      auth: "required",
      requiredPermissions: ["event:write"],
    },
  ],
};
