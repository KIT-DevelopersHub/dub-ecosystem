// Gantt FeatureModule source (authored against FE2's canonical contract, like the
// mail/usage features). The shell's composition (featureModules.tsx) wraps this
// route in GanttProvider fed by the one api-client and merges the nav ordering.
// One route:
//   /gantt → ガントチャート landing (pick an event → its task Gantt)
// requiredPermissions ["task:read"] mirrors the event-scoped Gantt route's gate,
// so the launcher tile shows only for users who can actually open a Gantt.
import type { ComponentType } from "react";
import type { identity } from "@dub/types";
import type { IconName } from "@dub/ui";
import { GanttLandingScreen } from "./GanttLandingScreen.tsx";

type PermissionKey = identity.PermissionKey;

export interface GanttSourceRoute {
  path: string;
  lazy: () => Promise<{ Component: ComponentType }>;
  auth: "required" | "public";
  requiredPermissions?: PermissionKey[];
}
export interface GanttNavEntry {
  label: string;
  path: string;
  icon: IconName;
  requiredPermissions?: PermissionKey[];
}

export const ganttRoutes: GanttSourceRoute[] = [
  {
    path: "/gantt",
    lazy: () => Promise.resolve({ Component: GanttLandingScreen as ComponentType }),
    auth: "required",
    requiredPermissions: ["task:read"],
  },
];

export const ganttNav: GanttNavEntry[] = [
  { label: "ガントチャート", path: "/gantt", icon: "clock", requiredPermissions: ["task:read"] },
];
