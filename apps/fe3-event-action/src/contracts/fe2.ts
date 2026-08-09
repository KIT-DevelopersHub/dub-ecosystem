// ─────────────────────────────────────────────────────────────────────────────
// FE2 app-shell contract shim.
//
// FE3 depends on FE2 for: FeatureModule registration (nested-delegation capable),
// @dub/api-client, the auth guard (requiredPermissions), createOptimisticMutation,
// can(permission), AuthState.me: MeResponse, toDisplayableError, and a re-export of
// FE1 useToast. FE2 is a separate parallel unit; this shim is the FE3-facing
// contract with a minimal local implementation. Replace with `@dub/app-shell` /
// `@dub/api-client` on integration — the shapes are frozen, the bodies are not.
// ─────────────────────────────────────────────────────────────────────────────
import * as React from "react";
import { create } from "zustand";
import type { gateway, identity } from "@dub/types";
import { fromResponse, isErrorResponse, type ErrorResponse } from "@dub/errors";

// ---- HTTP client (FE2 @dub/api-client absorbs the /api/v1 prefix; see API_PREFIX) ----
export interface HttpClient {
  get<T>(path: string, query?: Record<string, unknown>): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  del<T>(path: string, body?: unknown): Promise<T>;
}

// ---- Displayable error (toDisplayableError normalizes any thrown value) ----
export interface DisplayableError {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export function toDisplayableError(err: unknown): DisplayableError {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    const e = err as { code: unknown; message: unknown; retryable?: unknown; details?: unknown };
    if (typeof e.code === "string" && typeof e.message === "string") {
      return {
        code: e.code,
        message: e.message,
        retryable: e.retryable === true,
        details: e.details,
      };
    }
  }
  if (isErrorResponse(err)) {
    const b = (err as ErrorResponse).error;
    return { code: b.code, message: b.message, retryable: b.retryable, details: b.details };
  }
  const message = err instanceof Error ? err.message : "Unexpected error";
  return { code: "INTERNAL", message, retryable: false };
}

/** Reconstruct a DubError from a wire ErrorResponse (used by the mock/real client). */
export function errorFromWire(status: number, body: unknown) {
  return fromResponse(status, body);
}

// ---- Auth state (AuthState.me: MeResponse), fail-closed permission gate ----
export interface AuthState {
  me: gateway.MeResponse | null;
  loading: boolean;
  setMe: (me: gateway.MeResponse | null) => void;
  setLoading: (loading: boolean) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  me: null,
  loading: true,
  setMe: (me) => set({ me, loading: false }),
  setLoading: (loading) => set({ loading }),
}));

/** Pure permission check — org-wide effectivePermissions only (P0). Fail-closed. */
export function hasPermission(
  me: gateway.MeResponse | null,
  loading: boolean,
  permission: identity.PermissionKey,
): boolean {
  if (loading || me === null) return false; // fail-closed while unloaded
  return me.permissions.includes(permission);
}

/** React hook form of the FE2 `can()` guard. */
export function useCan(permission: identity.PermissionKey): boolean {
  const me = useAuthStore((s) => s.me);
  const loading = useAuthStore((s) => s.loading);
  return hasPermission(me, loading, permission);
}

// ---- FeatureModule registration contract (FE2 owns the router) ----
export interface FeatureRoute {
  path: string; // segment-owned path, e.g. "/events/:eventId"
  Component: React.ComponentType;
  requiredPermissions: identity.PermissionKey[]; // fail-closed while unloaded
  /** Nested routes delegated to another unit (FE4 nests tasks* under detail). */
  children?: FeatureRoute[];
  /** true = this segment is delegated to another unit; FE3 does not own the body. */
  delegated?: boolean;
}

export interface FeatureModule {
  id: string; // queryKey prefix + module id (FE3 = "events")
  routes: FeatureRoute[];
  /** Static init hook run at FE2 app bootstrap (e.g. plugin registration). */
  init?: () => void;
}
