// FE2 (front-end foundation) contract surface that FE5 depends on.
//
// FE2 is not yet built. These interfaces reproduce the *contract* FE5 codes
// against — the api-client I/F, the normalised `ApiError`, the `FeatureModule`
// registration shape, and `createOptimisticMutation`. When FE2 ships, this file
// is replaced by `import { ... } from "@spa/shell"` / `@dub/api-client` with no
// call-site changes (names and shapes match the frozen design).

import type { ComponentType } from "react";

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
export interface FeatureRoute {
  path: string; // "/notifications"
  // Lazy component loader (code-split unit chunk).
  component: () => Promise<{ default: ComponentType }>;
  requiredPermissions: string[]; // PermissionKey[]
}

export interface FeatureNav {
  id: string;
  label: string;
  to: string; // route path
  icon: string; // IconName
  requiredPermissions: string[];
  // Badge count source (FE5 injects useUnreadCount's value here; the shell must
  // NOT run its own poller — single source of truth is FE5).
  badgeSource?: () => number;
}

export interface FeatureModule {
  id: string; // "notifications"
  routes: FeatureRoute[];
  nav: FeatureNav[];
  // The one external embed slot FE5 supplies: the header bell.
  headerWidget?: ComponentType;
  requiredPermissions: string[];
}
