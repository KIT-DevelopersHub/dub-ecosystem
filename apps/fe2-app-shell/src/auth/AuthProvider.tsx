// Auth session + permission guards (design 2-3 / 6). Session comes from
// GET /api/v1/me (MeResponse). Permission gate is display-control only (server is
// authoritative); while /me is loading, can() is FALSE — fail-closed (design 6).
import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { appRegistry, policy } from "@dub/types";
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
  /** Per-app 無効/閲覧/編集 for every registered app (fail-closed 無効 while /me loads). */
  appLevel(appId: string): policy.AppAccessLevel;
  onUnauthenticated: () => void;
}

const AuthCtx = createContext<AuthContextValue | null>(null);

// ---- Proactive session refresh ---------------------------------------------
// The access token has a fixed TTL (SESSION_ACCESS_TTL_SEC). Reacting to 401s alone means
// the user is ALWAYS interrupted at the TTL boundary — every open request fails at once and
// the shell flickers (or logs out) while the client recovers. So we rotate the cookie a few
// minutes BEFORE sessionExpiresAt, and nothing ever 401s in normal use.
/** Rotate this long before `sessionExpiresAt`. Wide enough to absorb clock skew + a retry. */
const REFRESH_LEAD_MS = 5 * 60 * 1000;
/** setTimeout stores its delay in an int32: anything past this fires IMMEDIATELY. Clamp. */
const MAX_TIMEOUT_MS = 2_147_483_647;
/** Floor so an already-past / bogus expiry can never schedule a 0ms self-feeding loop. */
const MIN_TIMEOUT_MS = 1_000;

function refreshDelayMs(sessionExpiresAt: number, now: number): number {
  return Math.min(Math.max(sessionExpiresAt - REFRESH_LEAD_MS - now, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

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

  const queryClient = useQueryClient();
  // `api` is read through a ref so the rotation effect depends ONLY on the expiry. A caller
  // that builds its client inline would otherwise re-arm (and so indefinitely postpone) the
  // timer on every render.
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api; // in an effect, not during render (StrictMode / concurrent purity)
  }, [api]);
  // Primitive dep (not query.data): a refetch returning an equal expiry must NOT tear down
  // and re-create the timer, and a new expiry must.
  const sessionExpiresAt = query.data?.sessionExpiresAt ?? null;

  useEffect(() => {
    if (sessionExpiresAt === null || !Number.isFinite(sessionExpiresAt)) return undefined;

    let disposed = false;
    let inFlight = false;

    const rotate = async (): Promise<void> => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        // Harness clients (test-support FakeAuthProvider) are partial casts of ApiClient and
        // may not carry refresh; proactive rotation is then simply inactive.
        const ok = await apiRef.current.auth.refresh?.();
        // Re-read the session: the NEW sessionExpiresAt is what re-arms this effect. Without
        // the invalidation the timer fires exactly once and never again.
        if (ok && !disposed) await queryClient.invalidateQueries({ queryKey: queryKeys.me });
      } catch {
        // Swallow: a failed proactive rotation must not log anyone out (a transient blip
        // would end a healthy session). The reactive 401 path owns teardown.
      } finally {
        inFlight = false;
      }
    };

    const timer = setTimeout(() => void rotate(), refreshDelayMs(sessionExpiresAt, Date.now()));

    // A backgrounded tab has its timers throttled — or, after sleep/suspend, never fires
    // them at all. That is the "left it open overnight, came back logged out" case, so on
    // becoming visible we rotate immediately when the expiry is already near or past.
    const onVisibilityChange = (): void => {
      if (document.visibilityState !== "visible") return;
      if (sessionExpiresAt - Date.now() > REFRESH_LEAD_MS) return;
      void rotate();
    };
    const doc = typeof document === "undefined" ? null : document;
    doc?.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      disposed = true;
      clearTimeout(timer);
      doc?.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [sessionExpiresAt, queryClient]);

  const value = useMemo<AuthContextValue>(() => {
    const perms = state.status === "authenticated" ? new Set<string>(state.me.permissions) : null;
    // Per-app level: derive locally from `permissions`, then overlay the server's map
    // (/me appAccess) where present. Both come from the same policy module over the same key
    // set, so they agree — the overlay makes the server authoritative, and the local base
    // covers an app registered in a shell that ships BEFORE the gateway redeploys (otherwise
    // that app would read 無効 for everyone). Fail-closed when unauthenticated.
    const levels: Record<string, policy.AppAccessLevel> | null =
      state.status === "authenticated"
        ? { ...policy.appAccessMap(state.me.permissions), ...(state.me.appAccess ?? {}) }
        : null;
    return {
      state,
      // fail-closed: false while loading / unauthenticated
      can: (p: PermissionKey) => perms?.has(p) ?? false,
      appLevel: (appId: string) => levels?.[appId] ?? policy.AppAccessLevel.None,
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

/**
 * THE hook a feature uses to decide whether its write affordances are live.
 *
 * Returns the policy layer's capability flags for one app: `level` (無効/閲覧/編集), plus
 * `canView` / `canEdit` / `readOnly`. 閲覧 ⇒ `readOnly` is true, and every 保存/作成/削除
 * control in that app must be `disabled` — that is the flag the coordinator asked for, and
 * it is derived (never hand-listed), so a newly registered app is covered on day one.
 *
 * Fail-closed: everything false while /me loads and for an unknown app id. The server still
 * enforces the same levels (@dub/auth-client requireAppAccess) — this only shapes the UI.
 */
export function useAppCapability(appId: string): policy.AppCapability {
  const { appLevel } = useAuthCtx();
  const level = appLevel(appId);
  const canView = policy.levelAtLeast(level, policy.AppAccessLevel.View);
  const canEdit = level === policy.AppAccessLevel.Edit;
  return {
    appId,
    label: appRegistry.getApp(appId)?.label ?? appId,
    level,
    enabled: level !== policy.AppAccessLevel.None,
    canView,
    canEdit,
    readOnly: canView && !canEdit,
  };
}

/**
 * @deprecated Use {@link useAppCapability} — it adds `level` / `readOnly` (the 閲覧 flag) and
 * reads the server-derived map. Kept as a thin alias so existing call sites keep compiling.
 */
export function useAppCan(appId: string): { canView: boolean; canEdit: boolean } {
  const { canView, canEdit } = useAppCapability(appId);
  return { canView, canEdit };
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
