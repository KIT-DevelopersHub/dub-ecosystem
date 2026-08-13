// FeatureModule contract (design 2-3). FE3-FE7 each export one object matching
// this shape; the shell aggregates and registers them. Distributed via the in-app
// alias @spa/shell (no @dub/spa-shell package — theme5).
import type { ComponentType } from "react";
import type { identity } from "@dub/types";
import type { IconName } from "@dub/ui";

type PermissionKey = identity.PermissionKey;

export type FeatureModuleId = "events" | "tasks" | "gantt" | "notifications" | "chat" | "mail" | "usage" | "members" | "participation" | "driveshare" | "admin";

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
  // Permissions the viewer must hold for this launcher item to be shown (AND
  // semantics; omitted = visible to any authed user). The shell filters the
  // launcher by can() so e.g. the admin (ロール管理) tools appear for admins only,
  // matching each route's own requiredPermissions guard (defense in depth).
  requiredPermissions?: PermissionKey[];
}

export interface FeatureModule {
  id: FeatureModuleId;
  routes: FeatureRoute[];
  nav: NavEntry[];
  requiredPermissions?: PermissionKey[]; // applies to all module routes; fail-closed while /me loading
  headerWidget?: ComponentType; // e.g. FE5 NotificationBell
  homeWidget?: HomeWidget; // dashboard body a feature contributes to HomeScreen (design 2-1)
}

/** A feature-contributed dashboard card. FE2 owns the HomeScreen frame; each
 *  FE3–FE7 module may supply one body here (the comment on HomeScreen). The
 *  shell renders it inside a titled frame with a per-widget error boundary, so
 *  one failing widget never blanks the dashboard. `title` labels the frame;
 *  `Body` is mounted already wrapped in the feature's runtime Provider (see
 *  composition), so it may use the feature's own hooks. */
export interface HomeWidget {
  id: FeatureModuleId;
  title: string;
  Body: ComponentType;
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
  homeWidgets: HomeWidget[]; // dashboard cards, in module registration order
}
