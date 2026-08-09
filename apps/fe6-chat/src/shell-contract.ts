// Local mirror of FE2's FeatureModule contract.
//
// CANONICAL SOURCE (cross-PR): apps/fe2-app-shell/src/modules/types.tsx — that file
// is FE2-owned; do not edit it from here. FE6 depends on the contract *shape* only
// and keeps this self-styled mirror (no @dub/ui swap, no @spa/shell import) so the
// feature builds and tests standalone while FE2's shell alias is still unmerged.
// When lifted into apps/admin-spa this file is deleted and imports switch to the
// real "@spa/shell" alias.
import type { ComponentType } from "react";
import type { identity } from "@dub/types";

export type FeatureModuleId = "events" | "tasks" | "notifications" | "chat" | "admin";

export interface FeatureRoute {
  path: `/${string}`;
  // Lazy chunk factory resolving to a { Component } record (TanStack Router lazy shape).
  lazy: () => Promise<{ Component: ComponentType }>;
  auth: "required" | "public";
  requiredPermissions?: identity.PermissionKey[];
  children?: FeatureRoute[]; // nested delegation, per canonical contract
}

export interface NavEntry {
  label: string;
  path: string;
  // Canonical type is FE2's IconName string union (stubs/icons.tsx). Mirrored as a
  // plain string here to keep FE6 self-contained — the icon set lives in FE2 (cross-PR).
  icon: string;
  order: number;
  // Hook injection point: FE6 supplies useChatUnreadTotal.
  badgeSource?: () => number;
}

export interface FeatureModule {
  id: FeatureModuleId;
  routes: FeatureRoute[];
  nav: NavEntry[];
  requiredPermissions?: identity.PermissionKey[]; // applies to all module routes; fail-closed while /me loading
  headerWidget?: ComponentType;
}

// `can(permission)` hook contract provided by FE2 (backed by MeResponse
// .effectivePermissions). Unloaded permissions => fail-closed false.
export type CanFn = (permission: identity.PermissionKey) => boolean;
