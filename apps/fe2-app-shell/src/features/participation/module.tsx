// 参加届 FeatureModule source (authored against FE2's canonical contract, like mail /
// members). The shell's composition (featureModules.tsx) wraps these routes in
// ParticipationProvider fed by the one api-client and merges the nav ordering.
//
// The submit endpoint is open to any authenticated 運営 (they file their own 届), so
// the route carries auth:"required" with NO requiredPermissions — the launcher tile
// shows for every signed-in user. Write reflection onto the roster is re-authorized
// server-side by member-service.
import type { ComponentType } from "react";
import type { IconName } from "@dub/ui";
import { ParticipationPage } from "./ParticipationPage.tsx";

export interface ParticipationSourceRoute {
  path: string;
  lazy: () => Promise<{ Component: ComponentType }>;
  auth: "required" | "public";
}
export interface ParticipationNavEntry {
  label: string;
  path: string;
  icon: IconName;
}

export const participationRoutes: ParticipationSourceRoute[] = [
  {
    path: "/participation",
    lazy: () => Promise.resolve({ Component: ParticipationPage }),
    auth: "required",
  },
];

export const participationNav: ParticipationNavEntry[] = [
  { label: "参加届", path: "/participation", icon: "check-square" },
];
