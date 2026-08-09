// FE3 FeatureModule (id="events"). FE2 mounts this into the app shell and owns the
// router; FE3 declares its segment-owned routes, required permissions, and the
// tasks* delegation slot (FE4 nests its pages there). The ActionTypeRegistry is a
// module-level singleton so FE4/FE6 can register plugins at FE2 app init.
import type { FeatureModule } from "./contracts/fe2";
import { createActionTypeRegistry } from "./registry/ActionTypeRegistry";
import { genericActionPlugin } from "./components/GenericActionPanel";
import { EventListPage } from "./pages/EventListPage";
import { EventDetailPage } from "./pages/EventDetailPage";
import { ActionDetailPage } from "./pages/ActionDetailPage";
import { EventSettingsPage } from "./pages/EventSettingsPage";
import { routePaths } from "./lib/routes";

/** App-global registry; GenericActionPanel is the mandatory fallback. */
export const actionTypeRegistry = createActionTypeRegistry(genericActionPlugin);

export const eventFeatureModule: FeatureModule = {
  id: "events",
  init: () => {
    // FE4 calls actionTypeRegistry.register(taskActionPlugin()) at app init; FE6
    // registers nothing in P0a. Nothing to do inside FE3 itself.
  },
  routes: [
    {
      path: routePaths.list,
      Component: EventListPage,
      requiredPermissions: ["event:read"],
    },
    {
      path: routePaths.detail,
      Component: EventDetailPage,
      requiredPermissions: ["event:read"],
      children: [
        {
          // Delegated to FE4; FE3 exposes the nest slot only (no body).
          path: routePaths.tasks,
          Component: () => null,
          requiredPermissions: ["event:read"],
          delegated: true,
        },
      ],
    },
    {
      path: routePaths.action,
      Component: ActionDetailPage,
      requiredPermissions: ["event:read"],
    },
    {
      path: routePaths.settings,
      Component: EventSettingsPage,
      requiredPermissions: ["event:write"],
    },
  ],
};
