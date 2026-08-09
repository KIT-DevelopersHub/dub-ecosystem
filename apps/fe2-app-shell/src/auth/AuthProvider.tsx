// Auth session + permission guards (design 2-3 / 6). Session comes from
// GET /api/v1/me (MeResponse). Permission gate is display-control only (server is
// authoritative); while /me is loading, can() is FALSE — fail-closed (design 6).
import { createContext, useContext, useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { gateway, identity } from "@dub/types";
import type { ApiClient } from "../lib/api-client.tsx";
import { queryKeys } from "../lib/queryKeys.tsx";

type MeResponse = gateway.MeResponse;
type PermissionKey = identity.PermissionKey;

export type AuthState =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "authenticated"; me: MeResponse };

interface AuthContextValue {
  state: AuthState;
  can(p: PermissionKey): boolean;
  onUnauthenticated: () => void;
}

const AuthCtx = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  api,
  children,
  onUnauthenticated,
}: {
  api: ApiClient;
  children: ReactNode;
  onUnauthenticated?: () => void;
}): JSX.Element {
  const query = useQuery({
    queryKey: queryKeys.me,
    queryFn: () => api.auth.me(),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  const state: AuthState = query.isPending
    ? { status: "loading" }
    : query.data
      ? { status: "authenticated", me: query.data }
      : { status: "unauthenticated" };

  const value = useMemo<AuthContextValue>(() => {
    const perms = state.status === "authenticated" ? new Set<string>(state.me.permissions) : null;
    return {
      state,
      // fail-closed: false while loading / unauthenticated
      can: (p: PermissionKey) => perms?.has(p) ?? false,
      onUnauthenticated: onUnauthenticated ?? (() => {}),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, state.status === "authenticated" ? state.me : null, onUnauthenticated]);

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

function useAuthCtx(): AuthContextValue {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("Auth hooks must be used within <AuthProvider>");
  return ctx;
}

export function useAuth(): AuthState {
  return useAuthCtx().state;
}

export function usePermissions(): { can(p: PermissionKey): boolean } {
  const { can } = useAuthCtx();
  return { can };
}

/** Returns the resolved MeResponse or throws when not authenticated. */
export function useRequireAuth(): MeResponse {
  const state = useAuth();
  if (state.status !== "authenticated") {
    throw new Error("useRequireAuth: not authenticated");
  }
  return state.me;
}

export function RequireAuth({
  children,
  loadingFallback = null,
}: {
  children: ReactNode;
  loadingFallback?: ReactNode;
}): JSX.Element {
  const { state, onUnauthenticated } = useAuthCtx();
  useEffect(() => {
    if (state.status === "unauthenticated") onUnauthenticated();
  }, [state.status, onUnauthenticated]);

  if (state.status === "loading") return <>{loadingFallback}</>;
  if (state.status === "unauthenticated") return <></>;
  return <>{children}</>;
}

export function RequirePermission({
  permission,
  fallback = null,
  children,
}: {
  permission: PermissionKey;
  fallback?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const { can } = useAuthCtx();
  // fail-closed while loading (can() returns false)
  return can(permission) ? <>{children}</> : <>{fallback}</>;
}
