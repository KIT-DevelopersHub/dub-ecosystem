// ─────────────────────────────────────────────────────────────────────────────
// FE2 app-shell contract (FE3-facing). These are the FROZEN shapes FE3 depends on
// from the FE2 app shell; the real bodies live in apps/fe2-app-shell (the
// FeatureModule registry and @dub/api-client). This file MIRRORS FE2's real
// contract so integration is a pure import swap — it deliberately holds NO local
// re-implementations of the design-system or the api-client helpers:
//   • Icon / Button / Modal / FormField / LoadMore / useToast / ToastOptions
//     / DisplayableError / IconName  -> @dub/ui        (FE1 design system)
//   • error normalization (unknown -> DubError, .code/.message/.details)
//                                     -> @dub/errors    (wrapUnknown / DubError)
//   • createOptimisticMutation        -> ./hooks/useOptimisticMutation
//     (FE3-local hook; FE2's factory form is lower-level and still unmerged)
//
// Cross-PR note: @dub/api-client and @dub/app-shell are NOT yet merged, so FE3
// cannot import them. This file therefore keeps only the type surface (mirroring
// apps/fe2-app-shell/src/modules/types.tsx + src/lib/api-client.tsx) plus a
// minimal zustand auth store used by EventContext and the standalone dev harness.
// ─────────────────────────────────────────────────────────────────────────────
import { create } from "zustand";
import type { ComponentType } from "react";
import type { gateway, identity } from "@dub/types";
import type { IconName } from "@dub/ui";

type PermissionKey = identity.PermissionKey;

// ---- FeatureModule registration (mirror of apps/fe2-app-shell/src/modules/types.tsx) ----
export type FeatureModuleId = "events" | "tasks" | "notifications" | "chat" | "admin";

export interface FeatureRoute {
  path: `/${string}`;
  lazy: () => Promise<{ Component: ComponentType }>;
  auth: "required" | "public";
  requiredPermissions?: PermissionKey[];
  /** Nested delegation (e.g. FE4 nests tasks under FE3 /events/:eventId). */
  children?: FeatureRoute[];
}

export interface NavEntry {
  label: string;
  path: string;
  icon: IconName; // resolved by FE1 Icon (@dub/ui closed IconName union)
  order: number;
  /** Hook injection: FE5 useUnreadCount / FE6 useChatUnreadTotal. */
  badgeSource?: () => number;
}

export interface FeatureModule {
  id: FeatureModuleId;
  routes: FeatureRoute[];
  nav: NavEntry[];
  /** Applies to all module routes; fail-closed while /me is loading. */
  requiredPermissions?: PermissionKey[];
  headerWidget?: ComponentType; // e.g. FE5 NotificationBell
}

/** Flattened route with module-level permissions merged in (shell-resolved). */
export interface ResolvedRoute {
  path: string;
  lazy: FeatureRoute["lazy"];
  auth: FeatureRoute["auth"];
  requiredPermissions: PermissionKey[];
  moduleId: FeatureModuleId;
}

// ---- API client (mirror of apps/fe2-app-shell/src/lib/api-client.tsx public shape) ----
// FE2's @dub/api-client is the single gateway call surface. It absorbs the
// /api/v1 prefix, sends the cookie session (credentials: "include"), refreshes
// once on 401, retries GETs on 5xx/network, and rejects with an `ApiError`
// (Error subclass carrying .code/.status/.details/.message; see apps/fe2-app-shell
// api-client.tsx) — NOT a DubError. FE3 must normalize caught errors via
// errorMap.normalizeError (which duck-types the wire .code) before classifying,
// never bare @dub/errors wrapUnknown (that would collapse ApiError to INTERNAL).
// FE3 consumes the generic `request` surface via createHttpEventApi.
export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface RequestInput<TBody = unknown> {
  method: HttpMethod;
  path: `/api/v1/${string}`;
  body?: TBody;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ResourceClient {
  get<TRes>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<TRes>;
  post<TRes, TBody>(path: string, body: TBody): Promise<TRes>;
  patch<TRes, TBody>(path: string, body: TBody): Promise<TRes>;
  delete<TRes>(path: string): Promise<TRes>;
}

export interface ApiClient {
  request<TRes, TBody = unknown>(input: RequestInput<TBody>): Promise<TRes>;
  // FE2's real client additionally exposes tasks/gantt/notifications/chat/files
  // resource clients plus auth/bff; FE3 only needs events + identity.
  events: ResourceClient;
  identity: ResourceClient;
}

// ---- Auth state (FE2 AuthProvider store; used by EventContext + standalone dev) ----
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
  permission: PermissionKey,
): boolean {
  if (loading || me === null) return false; // fail-closed while unloaded
  return me.permissions.includes(permission);
}

/** React hook form of the FE2 `can()` guard. */
export function useCan(permission: PermissionKey): boolean {
  const me = useAuthStore((s) => s.me);
  const loading = useAuthStore((s) => s.loading);
  return hasPermission(me, loading, permission);
}
