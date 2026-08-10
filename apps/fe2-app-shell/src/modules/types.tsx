// FeatureModule contract (design 2-3). FE3-FE7 each export one object matching
// this shape; the shell aggregates and registers them. Distributed via the in-app
// alias @spa/shell (no @dub/spa-shell package — theme5).
import type { ComponentType } from "react";
import type { identity } from "@dub/types";
import type { IconName } from "@dub/ui";

type PermissionKey = identity.PermissionKey;

export type FeatureModuleId = "events" | "tasks" | "notifications" | "chat" | "mail" | "admin";

export interface FeatureRoute {
  path: `/${string}`;
  lazy: () => Promise<{ Component: ComponentType }>;
  auth: "required" | "public";
  requiredPermissions?: PermissionKey[];
  children?: FeatureRoute[]; // nested delegation (e.g. FE4 tasks under FE3 /events/:eventId)
}

export interface NavEntry {
  label: string;
  path: string;
  icon: IconName;
  order: number;
  badgeSource?: () => number; // hook injection: FE5 useUnreadCount / FE6 useChatUnreadTotal
}

export interface FeatureModule {
  id: FeatureModuleId;
  routes: FeatureRoute[];
  nav: NavEntry[];
  requiredPermissions?: PermissionKey[]; // applies to all module routes; fail-closed while /me loading
  headerWidget?: ComponentType; // e.g. FE5 NotificationBell
}

/** Flattened route with module-level permissions merged in (shell-resolved). */
export interface ResolvedRoute {
  path: string;
  lazy: FeatureRoute["lazy"];
  auth: FeatureRoute["auth"];
  requiredPermissions: PermissionKey[];
  moduleId: FeatureModuleId;
}

export interface Registry {
  modules: FeatureModule[];
  nav: NavEntry[]; // sorted by order asc
  routes: ResolvedRoute[]; // flattened (children included)
  headerWidgets: ComponentType[];
}
