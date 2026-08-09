// Local mirror of FE2's `@spa/shell` FeatureModule contract (theme5 1-2-5: no new
// @dub/spa-shell package — it's an apps-internal alias owned by FE2). FE6 depends
// on the contract *shape* only. When lifted into apps/admin-spa this file is
// deleted and the import switches to `@spa/shell`.
import type { ComponentType } from "react";
import type { identity } from "@dub/types";

export interface RouteDef {
  path: string;
  // Lazy chunk factory — TanStack Router route component.
  component: () => Promise<{ default: ComponentType<unknown> }>;
  requiredPermissions?: identity.PermissionKey[];
}

export interface NavEntry {
  id: string;
  label: string;
  to: string;
  icon?: string;
  // theme5 1-2-3: generalized to () => number so FE6 injects useChatUnreadTotal.
  badgeSource?: () => number;
}

export interface FeatureModule {
  id: string;
  routes: RouteDef[];
  nav: NavEntry;
}

// `can(permission)` hook contract provided by FE2 (backed by MeResponse
// .effectivePermissions). Unloaded permissions => fail-closed false (theme5 1-2-2).
export type CanFn = (permission: identity.PermissionKey) => boolean;
