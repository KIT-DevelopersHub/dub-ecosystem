// Hono context typing + small middleware/validation helpers shared by the routes.
import type { Context, MiddlewareHandler } from "hono";
import type { RequestContext } from "@dub/http";
import { getUserId } from "@dub/auth-client";
import type { identity } from "@dub/types";
import type { FieldError } from "@dub/errors";
import { errors } from "@dub/errors";
import type { Deps } from "./deps";
import type { Env } from "./env";

export interface AppEnv {
  Bindings: Env;
  Variables: {
    deps: Deps;
    dubCtx: RequestContext;
  };
}

export type AppContext = Context<AppEnv>;

export function getDeps(c: AppContext): Deps {
  return c.get("deps");
}

/** Request context (correlation id + acting user) for downstream SB/Queue calls. */
export function reqCtx(c: AppContext): RequestContext {
  const ctx = c.get("dubCtx");
  const userId = safeUserId(c);
  return { requestId: ctx.requestId, ...(userId ? { userId } : {}) };
}

function safeUserId(c: AppContext): string | undefined {
  try {
    return getUserId(c as unknown as Context);
  } catch {
    return undefined;
  }
}

/** requireAuth bound to the per-request auth client (trusted-header mode). */
export const requireAuth: MiddlewareHandler<AppEnv> = (c, next) =>
  getDeps(c).auth.requireAuth()(c as unknown as Context, next);

/** requirePermission bound to the per-request auth client. `fresh` forces a
 *  cache-bypassing sync authz check for the dangerous infra:* keys (design §6). */
export function requirePermission(permission: identity.PermissionKey, fresh = false): MiddlewareHandler<AppEnv> {
  return (c, next) =>
    getDeps(c).auth.requirePermission(permission, undefined, fresh ? { fresh: true } : undefined)(
      c as unknown as Context,
      next,
    );
}

// ---- tiny validators (VALIDATION_FAILED with FieldError[] details) ----
export async function readJson(c: AppContext): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw errors.validationFailed([{ field: "(body)", reason: "invalid" }], "request body must be a JSON object");
    }
    return body as Record<string, unknown>;
  } catch (e) {
    if (e && typeof e === "object" && "code" in e) throw e;
    throw errors.validationFailed([{ field: "(body)", reason: "invalid_json" }], "request body is not valid JSON");
  }
}

export function requireString(
  obj: Record<string, unknown>,
  field: string,
  fieldErrors: FieldError[],
): string | undefined {
  const v = obj[field];
  if (typeof v !== "string" || v.length === 0) {
    fieldErrors.push({ field, reason: typeof v === "undefined" ? "required" : "invalid" });
    return undefined;
  }
  return v;
}

export function optionalString(
  obj: Record<string, unknown>,
  field: string,
  fieldErrors: FieldError[],
): string | undefined {
  const v = obj[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    fieldErrors.push({ field, reason: "invalid" });
    return undefined;
  }
  return v;
}

export function assertValid(fieldErrors: FieldError[]): void {
  if (fieldErrors.length > 0) throw errors.validationFailed(fieldErrors);
}
