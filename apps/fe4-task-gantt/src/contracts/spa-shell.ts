// Local stand-in for FE2's `@dub/api-client` + SPA shell contracts.
// FE2 owns these for real; FE4 depends only on the shapes described in
// FE4 design §5. When the `@dub/api-client` / `@spa/shell` packages land,
// replace these imports — FE4 code references only the types below.
import type { ErrorResponse } from "@dub/errors";
import { CommonErrorCodes } from "@dub/errors";
import type { identity } from "@dub/types";

type PermissionKey = identity.PermissionKey;

export type ApiPath = `/api/v1/${string}`;
export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface ApiRequest {
  method: HttpMethod;
  path: ApiPath;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
}

/** The single gateway-facing client (FE2). FE4 never knows a host. */
export interface ApiClient {
  request<T>(req: ApiRequest): Promise<T>;
}

/** Normalized, render-ready error (FE2 `toDisplayableError` output). */
export interface DisplayableError {
  code: string;
  message: string;
  status: number;
  retryable: boolean;
  details?: unknown;
  requestId?: string;
}

/** Thrown by the client on any non-2xx (carries the wire ErrorResponse). */
export class ApiError extends Error {
  readonly status: number;
  readonly body: ErrorResponse;
  constructor(status: number, body: ErrorResponse) {
    super(body.error.message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** FE2 `toDisplayableError` (boundary reconstruction of any thrown value). */
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

// ---- SPA shell (FE2) FeatureModule contract (subset FE4 needs) ----
export interface RouteDef {
  path: string;
  /** component loader (FE2 wires to TanStack Router). */
  component: () => unknown;
  requiredPermissions?: PermissionKey[];
}

export interface NavItem {
  label: string;
  to: string;
  icon?: string;
}

export interface FeatureModule {
  id: string; // queryKey namespace root + route ownership (FE2 rule)
  routes: RouteDef[];
  nav?: NavItem[];
  /** routes delegated under another module's tree (e.g. FE3 `/events/:eventId`). */
  nestedRoutes?: { parentModuleId: string; routes: RouteDef[] };
}

// ---- optimistic mutation helper (FE2 `createOptimisticMutation`) ----
export interface OptimisticMutationSpec<TVars, TSnapshot, TResult> {
  mutationFn: (vars: TVars) => Promise<TResult>;
  /** apply the change locally, returning a snapshot for rollback. */
  optimisticUpdate: (vars: TVars) => TSnapshot;
  rollback: (snapshot: TSnapshot) => void;
  onSuccess?: (result: TResult, vars: TVars) => void;
  onError?: (error: DisplayableError, vars: TVars, snapshot: TSnapshot) => void;
}

/**
 * Minimal `createOptimisticMutation`: apply → call → confirm/rollback.
 * FE2's real version binds to TanStack Query; the observable contract
 * (snapshot on failure is rolled back, DisplayableError surfaced) is identical.
 */
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
