// Local contract mirror of FE2's app-shell surface (`@dub/api-client` +
// `@spa/shell` FeatureModule contract). FE2 owns these for real; this file is a
// self-styled, structurally-identical stand-in so FE4 builds/tests standalone
// while FE2 is unmerged (cross-PR: keep local, do NOT add @dub/api-client /
// @dub/fe2-app-shell to package.json until they land — see repo build rules).
//
// Integration swap (when FE2 ships):
//   - `import type { ApiClient, RequestInput, ResourceClient } from "@dub/api-client";`
//   - `import { ApiError } from "@dub/api-client";`
//   - `import type { FeatureModule, FeatureRoute, NavEntry, FeatureModuleId, IconName } from "@dub/fe2-app-shell";`
// The *shapes* below are the FE2-facing contract and mirror
// `apps/fe2-app-shell/src/lib/api-client.tsx` + `.../modules/types.tsx`.
import type { ComponentType } from "react";
import type { ErrorResponse } from "@dub/errors";
import { CommonErrorCodes } from "@dub/errors";
import type { identity, gateway } from "@dub/types";

type PermissionKey = identity.PermissionKey;

// ─────────────────────────────────────────────────────────────────────────────
// API client (mirror of FE2 `@dub/api-client`, design 2-4). FE4 callers never
// write fetch directly; every call goes through the single gateway client. The
// real client absorbs the `/api/v1` prefix, cookie session, 401 refresh, and
// GET retry — FE4 only depends on the type surface below.
// ─────────────────────────────────────────────────────────────────────────────
export type ApiPath = `/api/v1/${string}`;
export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface RequestInput<TBody = unknown> {
  method: HttpMethod;
  path: ApiPath;
  body?: TBody;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** login-start reply is the OAuth authorize URL to redirect the browser to. */
export interface AuthLoginStartResponse {
  authorizeUrl: string;
}

/** Resource sub-client (prefix-scoped convenience over `request`). */
export interface ResourceClient {
  get<TRes>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<TRes>;
  post<TRes, TBody>(path: string, body: TBody): Promise<TRes>;
  patch<TRes, TBody>(path: string, body: TBody): Promise<TRes>;
  delete<TRes>(path: string): Promise<TRes>;
}

/** The single gateway-facing client (FE2). FE4 never knows a host. */
export interface ApiClient {
  request<TRes, TBody = unknown>(input: RequestInput<TBody>): Promise<TRes>;
  auth: {
    loginStart(redirectPath?: string): Promise<AuthLoginStartResponse>;
    logout(): Promise<void>;
    me(): Promise<gateway.MeResponse>;
  };
  bff: { home(): Promise<gateway.BffHomeResponse> };
  events: ResourceClient;
  tasks: ResourceClient;
  gantt: ResourceClient;
  notifications: ResourceClient;
  chat: ResourceClient;
  identity: ResourceClient;
  files: ResourceClient;
}

/** Thrown by the client on any non-2xx (carries the wire ErrorResponse). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly details?: unknown;
  readonly body: ErrorResponse;

  constructor(status: number, body: ErrorResponse) {
    super(body.error.message);
    this.name = "ApiError";
    this.status = status;
    this.code = body.error.code;
    this.details = body.error.details;
    this.body = body;
    if (body.error.requestId !== undefined) this.requestId = body.error.requestId;
    Object.setPrototypeOf(this, ApiError.prototype);
  }

  /** Design compat alias for the wire `requestId` correlation field. */
  get correlationId(): string | undefined {
    return this.requestId;
  }

  static isApiError(e: unknown): e is ApiError {
    return e instanceof ApiError;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return ApiError.isApiError(e);
}

// ─────────────────────────────────────────────────────────────────────────────
// Displayable error (self-styled FE4 mirror of FE2 `toDisplayableError` output;
// FE4 error-mapping consumes `.code` / `.message`). Kept local — not part of the
// FeatureModule/ApiClient reshape.
// ─────────────────────────────────────────────────────────────────────────────
export interface DisplayableError {
  code: string;
  message: string;
  status: number;
  retryable: boolean;
  details?: unknown;
  requestId?: string;
}

/** Boundary reconstruction of any thrown value into a render-ready error. */
export function toDisplayableError(e: unknown): DisplayableError {
  if (isApiError(e)) {
    const err = e.body.error;
    return {
      code: err.code,
      message: err.message,
      status: e.status,
      retryable: err.retryable,
      ...(err.details !== undefined ? { details: err.details } : {}),
      ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
    };
  }
  return {
    code: CommonErrorCodes.INTERNAL,
    message: e instanceof Error ? e.message : "Unexpected error",
    status: 500,
    retryable: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FeatureModule contract (mirror of FE2 `modules/types.tsx`, design 2-3). Each
// FE3–FE7 unit exports one FeatureModule; the shell aggregates and registers
// them. Nested delegation (FE4 tasks under FE3 `/events/:eventId`) is expressed
// via `FeatureRoute.children`. Distributed via the in-app alias @spa/shell.
// ─────────────────────────────────────────────────────────────────────────────

/** Closed FE1 IconName union used by `NavEntry.icon` (mirror of FE2 stubs/icons). */
export type IconName =
  | "home"
  | "calendar"
  | "check-square"
  | "bell"
  | "message-square"
  | "shield"
  | "settings"
  | "users"
  | "file"
  | "alert-triangle"
  | "log-out";

export type FeatureModuleId = "events" | "tasks" | "notifications" | "chat" | "admin";

export interface FeatureRoute {
  path: `/${string}`;
  lazy: () => Promise<{ Component: ComponentType }>;
  auth: "required" | "public";
  requiredPermissions?: PermissionKey[];
  /** Nested delegation (e.g. FE4 tasks under FE3 `/events/:eventId`). */
  children?: FeatureRoute[];
}

export interface NavEntry {
  label: string;
  path: string;
  icon: IconName;
  order: number;
  /** hook injection: FE5 useUnreadCount / FE6 useChatUnreadTotal. */
  badgeSource?: () => number;
}

export interface FeatureModule {
  id: FeatureModuleId;
  routes: FeatureRoute[];
  nav: NavEntry[];
  /** applies to all module routes; fail-closed while /me loading. */
  requiredPermissions?: PermissionKey[];
  headerWidget?: ComponentType;
}

// ─────────────────────────────────────────────────────────────────────────────
// Optimistic mutation helper (self-styled FE4 mirror; FE2's real version binds
// to TanStack Query). The observable contract — snapshot on failure is rolled
// back, DisplayableError surfaced — is identical. Kept local (out of the
// FeatureModule/ApiClient reshape).
// ─────────────────────────────────────────────────────────────────────────────
export interface OptimisticMutationSpec<TVars, TSnapshot, TResult> {
  mutationFn: (vars: TVars) => Promise<TResult>;
  optimisticUpdate: (vars: TVars) => TSnapshot;
  rollback: (snapshot: TSnapshot) => void;
  onSuccess?: (result: TResult, vars: TVars) => void;
  onError?: (error: DisplayableError, vars: TVars, snapshot: TSnapshot) => void;
}

export function createOptimisticMutation<TVars, TSnapshot, TResult>(
  spec: OptimisticMutationSpec<TVars, TSnapshot, TResult>,
): (vars: TVars) => Promise<TResult> {
  return async (vars: TVars) => {
    const snapshot = spec.optimisticUpdate(vars);
    try {
      const result = await spec.mutationFn(vars);
      spec.onSuccess?.(result, vars);
      return result;
    } catch (e) {
      spec.rollback(snapshot);
      spec.onError?.(toDisplayableError(e), vars, snapshot);
      throw e;
    }
  };
}

// ---- toast (FE1 re-exported through FE2) ----
export type ToastKind = "info" | "success" | "error" | "warning";
export interface Toast {
  kind: ToastKind;
  message: string;
}
export type PushToast = (toast: Toast) => void;
