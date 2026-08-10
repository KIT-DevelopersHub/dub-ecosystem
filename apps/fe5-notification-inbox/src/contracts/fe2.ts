// FE2 (front-end foundation) contract surface that FE5 depends on — a LOCAL
// MIRROR of the `@spa/shell` public barrel (apps/fe2-app-shell/src/index.tsx).
//
// Cross-PR: FE2's shell IS present in feat/ecosystem-build, but it is not yet
// resolvable from FE5 — its package `@dub/fe2-app-shell` exposes no `exports`
// barrel and the intended `@spa/shell` alias is "kept as a relative import for
// now" (see the barrel header). So FE5 keeps this mirror and swaps every import
// below to `@spa/shell` in a follow-up PR once the alias/exports land; the shapes
// here are copied verbatim from FE2's `modules/types.tsx` so that swap is a pure
// import change.
//   - FeatureModule / FeatureRoute / NavEntry  <- FE2 src/modules/types.tsx
//   - ApiClient / ApiError / isApiError        <- FE2 src/lib/api-client.tsx
//   - OptimisticMutationSpec                    <- FE2 src/lib/optimistic.tsx (createOptimisticMutation)

import type { ComponentType } from "react";
import type { IconName } from "@dub/ui";

// ---- @dub/api-client: normalised error (from @dub/errors ErrorResponse) ----
// api-client normalises the wire ErrorResponse into this before throwing.
export interface ApiError extends Error {
  readonly code: string; // SCREAMING_SNAKE (UNAUTHENTICATED, NOTIF_INBOX_ITEM_NOT_FOUND, ...)
  readonly status: number; // HTTP status
  readonly requestId?: string; // x-dub-request-id
  readonly retryable: boolean;
  readonly details?: unknown;
}

export function isApiError(e: unknown): e is ApiError {
  return (
    e instanceof Error &&
    typeof (e as ApiError).code === "string" &&
    typeof (e as ApiError).status === "number"
  );
}

// ---- @dub/api-client: the request surface FE5 uses ----
// Real client injects auth header + correlation id and normalises errors.
export interface ApiClient {
  get<T>(path: string, query?: Record<string, unknown>): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
}

// ---- FE2 optimistic mutation helper ----
// Apply the optimistic change immediately, run the request, roll back on
// failure (unless the error is classified as a "drop" -> keep the removal).
export interface OptimisticMutationSpec<TArgs> {
  // Mutate local state first; returns a rollback closure.
  optimistic: (args: TArgs) => () => void;
  // The server call.
  commit: (args: TArgs) => Promise<void>;
  // Decide, from a failed commit, whether to roll back (default) or keep the
  // optimistic state (e.g. 404 -> item already gone, keep the removal).
  onError?: (err: unknown, rollback: () => void, args: TArgs) => void;
}

// ---- FE2 SPA shell: FeatureModule registration contract ----
// Mirror of FE2 `src/modules/types.tsx` (design 2-3). FE3-FE7 each export one
// FeatureModule matching this shape; the shell flattens routes, merges module
// permissions, sorts nav by `order`, and collects `headerWidget`s.

// Closed set of module ids the shell knows (FE2 FeatureModuleId). FE5 owns
// "notifications".
export type FeatureModuleId = "events" | "tasks" | "notifications" | "chat" | "admin";

export interface FeatureRoute {
  path: `/${string}`; // "/notifications"
  // Lazy, code-split loader. NOTE the frozen shape is `{ Component }` (not the
  // React-Router `{ default }`) — the shell renders `route.lazy().then(m => m.Component)`.
  lazy: () => Promise<{ Component: ComponentType }>;
  auth: "required" | "public";
  // FE2 types this as identity.PermissionKey[]. FE5's route guards use the
  // self-scoped keys `notif:inbox:self` / `notif:prefs:self`, which are NOT yet
  // in @dub/types PERMISSION_CATALOG (only `notif:send` / `notif:admin` exist).
  // Kept as string[] until identity-roster adds those keys — cross-PR (see routes.ts).
  requiredPermissions?: string[];
  children?: FeatureRoute[]; // nested delegation (unused by FE5)
}

export interface NavEntry {
  label: string;
  path: string; // route path
  icon: IconName; // FE2 uses @dub/ui/icons IconName; mirrored via ./fe1 until @dub/ui ships
  order: number; // shell sorts nav ascending
  // Badge count source (FE5 injects useUnreadCount's value here; the shell must
  // NOT run its own poller — single source of truth is FE5's unread-store).
  badgeSource?: () => number;
}

export interface FeatureModule {
  id: FeatureModuleId; // "notifications"
  routes: FeatureRoute[];
  nav: NavEntry[];
  // Applies to all module routes (fail-closed while /me loading). See note on
  // FeatureRoute.requiredPermissions re: string[] vs PermissionKey[].
  requiredPermissions?: string[];
  // The one external embed slot FE5 supplies: the header bell.
  headerWidget?: ComponentType;
}
