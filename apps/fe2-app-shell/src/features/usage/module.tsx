// Usage FeatureModule source (authored against FE2's canonical contract, like the
// mail feature). The shell's composition (featureModules.tsx) wraps this route in
// UsageProvider fed by the one api-client and merges the nav ordering. One route:
//   /usage → free-tier usage & billing-guard dashboard
// auth:"required" so an unauthenticated visitor is bounced to /login by the shell.
//
// requiredPermissions: ["infra:read"] — the backend (services/usage-meter) gates
// GET /usage/summary on infra:read, so the shell mirrors that: the nav entry is
// hidden and the route shows PermissionDeniedScreen for anyone without it. This
// aligns the FE with the real access policy (previously the nav showed for every
// signed-in user, who then got a forbidden read + a misleading sample board).
import type { ComponentType } from "react";
import type { identity } from "@dub/types";
import type { IconName } from "@dub/ui";
import { UsageDashboard } from "./UsageDashboard.tsx";

type PermissionKey = identity.PermissionKey;

/** Permission required to view usage — matches usage-meter's server-side gate. */
export const USAGE_VIEW_PERMISSION: PermissionKey = "infra:read";

export interface UsageSourceRoute {
  path: string;
  lazy: () => Promise<{ Component: ComponentType }>;
  auth: "required" | "public";
  requiredPermissions?: PermissionKey[];
}
export interface UsageNavEntry {
  label: string;
  path: string;
  icon: IconName;
  requiredPermissions?: PermissionKey[];
}

export const usageRoutes: UsageSourceRoute[] = [
  {
    path: "/usage",
    lazy: () => Promise.resolve({ Component: UsageDashboard }),
    auth: "required",
    requiredPermissions: [USAGE_VIEW_PERMISSION],
  },
];

export const usageNav: UsageNavEntry[] = [
  { label: "無料枠 / 課金ガード", path: "/usage", icon: "shield", requiredPermissions: [USAGE_VIEW_PERMISSION] },
];
