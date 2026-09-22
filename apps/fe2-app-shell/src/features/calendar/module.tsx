// Calendar FeatureModule source (authored against FE2's canonical contract, like
// the gantt/mail/usage features). The shell's composition (featureModules.tsx)
// wraps this route in CalendarProvider fed by the one api-client and merges the
// nav ordering. One route:
//   /calendar → month/week calendar over the shared task data (task-service)
// requiredPermissions ["task:read"] mirrors the マイタスク / ガント gate, so the
// launcher tile shows only for users who can actually read tasks.
import type { ComponentType } from "react";
import type { identity } from "@dub/types";
import type { IconName } from "@dub/ui";
import { CalendarScreen } from "./CalendarScreen.tsx";

type PermissionKey = identity.PermissionKey;

export interface CalendarSourceRoute {
  path: string;
  lazy: () => Promise<{ Component: ComponentType }>;
  auth: "required" | "public";
  requiredPermissions?: PermissionKey[];
}
export interface CalendarNavEntry {
  label: string;
  path: string;
  icon: IconName;
  requiredPermissions?: PermissionKey[];
}

export const calendarRoutes: CalendarSourceRoute[] = [
  {
    path: "/calendar",
    lazy: () => Promise.resolve({ Component: CalendarScreen as ComponentType }),
    auth: "required",
    requiredPermissions: ["task:read"],
  },
];

export const calendarNav: CalendarNavEntry[] = [
  { label: "カレンダー", path: "/calendar", icon: "calendar", requiredPermissions: ["task:read"] },
];
