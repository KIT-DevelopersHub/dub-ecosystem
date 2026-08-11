// Usage FeatureModule source (authored against FE2's canonical contract, like the
// mail feature). The shell's composition (featureModules.tsx) wraps this route in
// UsageProvider fed by the one api-client and merges the nav ordering. One route:
//   /usage → free-tier usage & billing-guard dashboard
// auth:"required" so an unauthenticated visitor is bounced to /login by the shell.
// No requiredPermissions: any signed-in operator may view usage (read-only).
import type { ComponentType } from "react";
import type { IconName } from "@dub/ui";
import { UsageDashboard } from "./UsageDashboard.tsx";

export interface UsageSourceRoute {
  path: string;
  lazy: () => Promise<{ Component: ComponentType }>;
  auth: "required" | "public";
}
export interface UsageNavEntry {
  label: string;
  path: string;
  icon: IconName;
}

export const usageRoutes: UsageSourceRoute[] = [
  { path: "/usage", lazy: () => Promise.resolve({ Component: UsageDashboard }), auth: "required" },
];

export const usageNav: UsageNavEntry[] = [{ label: "無料枠 / 課金ガード", path: "/usage", icon: "shield" }];
