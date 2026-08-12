// Usage FeatureModule source (authored against FE2's canonical contract, like the
// mail feature). The shell's composition (featureModules.tsx) wraps this route in
// UsageProvider fed by the one api-client and merges the nav ordering. One route:
//   /usage → free-tier usage & billing-guard dashboard
// auth:"required" so an unauthenticated visitor is bounced to /login by the shell.
//
// No requiredPermissions — the free-tier usage numbers are safe to show to every signed-in
// user (there is nothing to hide), matching usage-meter's server gate, which now requires
// authentication but no special permission. So the nav tile shows for anyone logged in and
// the route renders for anyone logged in; the read is a safe D1 snapshot. The #177 neutral
// fallback (never invent a fake danger % when a read is unavailable) is unchanged, and the
// illustrative mock stays VITE_DEMO-only.
import type { ComponentType } from "react";
import type { identity } from "@dub/types";
import type { IconName } from "@dub/ui";
import { UsageDashboard } from "./UsageDashboard.tsx";

type PermissionKey = identity.PermissionKey;

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
  },
];

export const usageNav: UsageNavEntry[] = [
  { label: "無料枠 / 課金ガード", path: "/usage", icon: "shield" },
];
