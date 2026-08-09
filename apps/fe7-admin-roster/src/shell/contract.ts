// Local model of the FE2 `@spa/shell` registration contract (P0b frozen 1-2).
//
// FE2 is a sibling unit and is not yet published, so FE7 models the contract it
// consumes here. In P1 this file is deleted and replaced by `import ... from
// "@spa/shell"`. Shapes below track the FE7 design §2-2 / §5 dependency table and
// the P0b freeze: FeatureModule one-object registration, permission-based route
// guards (PermissionKey, not role), TanStack Router, ResourceClient typed fetch,
// createOptimisticMutation, can(permission), AuthState.me = gateway.MeResponse.
import type { ComponentType } from "react";
import type { identity, gateway } from "@dub/types";
import type { ErrorResponse } from "@dub/errors";

// ---- FE1 icon union (frozen 1-1-7). Local subset used by FE7 nav entries. ----
export type IconName = "users" | "shield" | "history" | "key";

// ---- Route + nav registration (frozen 1-2-2: requiredPermissions is PermissionKey[]) ----
export interface FeatureRoute {
  path: string; // absolute, flat under /admin (no nested delegation)
  component: ComponentType;
  requiredPermissions: identity.PermissionKey[]; // AND semantics; [] = any authed user
}

export interface NavEntry {
  label: string; // ja direct string (frozen 1-6-5), not an i18n key
  path: string;
  icon: IconName;
  order: number;
  requiredPermissions: identity.PermissionKey[];
  badgeSource?: string;
}

export interface FeatureModule {
  id: string; // "admin"
  routes: FeatureRoute[];
  nav: NavEntry[];
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
