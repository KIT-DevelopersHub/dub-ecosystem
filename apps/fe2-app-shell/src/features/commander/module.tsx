// Commander FeatureModule source (FE2-local feature, like mail/usage/lp). The shell's
// composition (featureModules.tsx) imposes nav ordering and ANDs the per-app access gate
// (app:commander:view) + module-level identity:admin. One route:
//   /commander → run console (drives the LOCAL Claude Code exec bridge) + phase board.
// auth:"required" so an unauthenticated visitor is bounced to /login by the shell. The
// tile is admin-only and member-hidden (NOT in releaseGate PUBLISHED_APPS).
import type { ComponentType } from "react";
import type { IconName } from "@dub/ui";
import { CommanderScreen } from "./CommanderScreen.tsx";

export interface CommanderSourceRoute {
  path: string;
  lazy: () => Promise<{ Component: ComponentType }>;
  auth: "required" | "public";
}
export interface CommanderNavEntry {
  label: string;
  path: string;
  icon: IconName;
}

export const commanderRoutes: CommanderSourceRoute[] = [
  {
    path: "/commander",
    lazy: () => Promise.resolve({ Component: CommanderScreen }),
    auth: "required",
  },
];

export const commanderNav: CommanderNavEntry[] = [
  { label: "Commander", path: "/commander", icon: "code" },
];
