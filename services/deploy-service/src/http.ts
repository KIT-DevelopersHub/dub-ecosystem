// Hono context typing + small validation helpers shared by the routes.
// Authorization is NOT here any more: it is declared in src/policy-table.ts and enforced by
// the single policyGate mount in app.ts. The former requireAuth / requirePermission wrappers
// went away with it — do not reintroduce a per-route check.
import type { Context } from "hono";
import type { RequestContext } from "@dub/http";
import type { PolicyGateVars } from "@dub/policy-gate";
import type { FieldError } from "@dub/errors";
import { errors } from "@dub/errors";
import type { Deps } from "./deps";
import type { Env } from "./env";

export interface AppEnv {
  Bindings: Env;
  /** `userId` is inherited from PolicyGateVars: the gate publishes the actor it
   *  authenticated, which is where `reqCtx` now reads it from. */
  Variables: PolicyGateVars & {
    deps: Deps;
    dubCtx: RequestContext;
  };
}

export type AppContext = Context<AppEnv>;

export function getDeps(c: AppContext): Deps {
  return c.get("deps");
}

/**
 * Request context (correlation id + acting user) for downstream SB/Queue calls, and the
 * `actorId` every audit record is attributed to.
 *
 * The actor comes from the gate's `userId` variable. Every route of this service demands
 * permission keys, so policyGate has always set it by the time a handler runs — the
 * fallback keeps the type honest rather than guarding a reachable case.
 */
export function reqCtx(c: AppContext): RequestContext {
  const ctx = c.get("dubCtx");
  const userId = c.get("userId");
  return { requestId: ctx.requestId, ...(userId ? { userId } : {}) };
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
