// DriveShare FeatureModule source (authored against FE2's canonical contract, like
// mail). The shell's composition (featureModules.tsx) wraps this route in
// DriveShareProvider fed by the one api-client and merges the nav ordering. One route:
//   /driveshare → the Hackit Drive sharing manager (list + permissions CRUD)
// auth:"required" so an unauthenticated visitor is bounced to /login by the shell.
// The route is NOT gated on drive:read/drive:write at the SPA layer (those keys are not
// in the frozen PERMISSION_CATALOG yet, so /me never carries them); the drive-share
// backend is the authoritative gate — it authorizes drive:read/drive:write per request.
import type { ComponentType } from "react";
import type { IconName } from "@dub/ui";
import { DriveShareScreen } from "./DriveShareScreen.tsx";

export interface DriveShareSourceRoute {
  path: string;
  lazy: () => Promise<{ Component: ComponentType }>;
  auth: "required" | "public";
}
export interface DriveShareNavEntry {
  label: string;
  path: string;
  icon: IconName;
}

export const driveShareRoutes: DriveShareSourceRoute[] = [
  { path: "/driveshare", lazy: () => Promise.resolve({ Component: DriveShareScreen }), auth: "required" },
];

export const driveShareNav: DriveShareNavEntry[] = [{ label: "Drive共有", path: "/driveshare", icon: "users" }];
