// Local model of the FE2 `@spa/shell` FeatureModule registration contract.
//
// FE2 (apps/fe2-app-shell) is a sibling unit and is not yet merged, so FE7 mirrors
// the contract it consumes here. Shapes below track FE2's real
// `src/modules/types.tsx` (the P0b freeze): one FeatureModule per feature, lazy
// code-split routes (`lazy: () => Promise<{ Component }>`), permission-based route
// guards (PermissionKey[]), and NavEntry ordered by `order`. In P1 this file is
// deleted and replaced by `import ... from "@spa/shell"`.
//
// Cross-PR note: this is a LOCAL mirror only — FE7 must not import from
// apps/fe2-app-shell (unmerged). Keep it in lock-step with FE2's types.tsx.
import type { ComponentType } from "react";
import type { identity, gateway } from "@dub/types";
import type { ErrorResponse } from "@dub/errors";

// ---- FE1 icon union (frozen 1-1-7). Local subset used by FE7 nav entries. In FE2
// the real NavEntry.icon is FE1's IconName; FE7 only needs this handful. ----
export type IconName = "users" | "shield" | "history" | "key";

// ---- Feature module identifiers (FE2 real: FeatureModuleId union). ----
export type FeatureModuleId = "events" | "tasks" | "notifications" | "chat" | "admin";

// ---- Route registration (FE2 real shape: lazy Component + auth + optional perms). ----
export interface FeatureRoute {
  path: `/${string}`; // absolute, flat under /admin (no nested delegation in P0)
  lazy: () => Promise<{ Component: ComponentType }>; // code-split page body
  auth: "required" | "public";
  requiredPermissions?: identity.PermissionKey[]; // AND semantics; omitted = any authed user
  children?: FeatureRoute[]; // nested delegation (unused by FE7 in P0)
}

// ---- Sidebar nav entry (FE2 real shape: ordered, no per-entry permissions; the
// shell derives visibility from the matching route's requiredPermissions). ----
export interface NavEntry {
  label: string; // ja direct string (frozen 1-6-5), not an i18n key
  path: string;
  icon: IconName;
  order: number;
  badgeSource?: () => number; // hook injection (FE5/FE6); unused by FE7
}

export interface FeatureModule {
  id: FeatureModuleId; // "admin"
  routes: FeatureRoute[];
  nav: NavEntry[];
  requiredPermissions?: identity.PermissionKey[]; // applies to all module routes
  headerWidget?: ComponentType; // e.g. FE5 NotificationBell; unused by FE7
}

// ---- Typed fetch client provided by FE2 (frozen: ResourceClient) ----
export interface ResourceClient {
  get<T>(path: string, query?: Record<string, unknown>): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  delete(path: string): Promise<void>;
}

// ResourceClient rejects with a typed ErrorResponse (via @dub/errors boundary
// reconstruction) so features can branch on `.code`.
export type { ErrorResponse };

// ---- Auth state exposed by FE2 (frozen: AuthState.me = gateway.MeResponse) ----
export interface AuthState {
  me: gateway.MeResponse | null; // null while loading -> can() is fail-closed
}

// can(permission): FE2 helper derived from MeResponse.permissions (org-wide).
export type Can = (permission: identity.PermissionKey) => boolean;
