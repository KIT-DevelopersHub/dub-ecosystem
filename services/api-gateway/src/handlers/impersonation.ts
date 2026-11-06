// POST /api/v1/admin/users/:userId/impersonation — admin starts viewing the app AS a member
// (代理表示). Gateway-owned for the same reason as the admin password pair: auth-service's
// start route is internal-only, so the gateway authorizes (identity:impersonate, decided by
// the gate from POLICY_TABLE), then forwards s2s with the admin's OWN session token as a
// bearer. auth-service checks target eligibility, parks the admin token, mints the
// impersonation session and returns the Set-Cookie value, which is relayed here. The
// browser body carries only the impersonation info (no token).
import type { Context } from "hono";
import { errors } from "@dub/errors";
import type { RequestContext } from "@dub/http";
import type { auth } from "@dub/types";
import type { GatewayEnv } from "../env";
import type { GatewayVariables } from "../context";
import { getRequestId } from "../context";
import { createServices } from "../services";
import { extractToken } from "../auth";
import { authedActor } from "../policy";

type Ctx = Context<{ Bindings: GatewayEnv; Variables: GatewayVariables }>;

/** auth-service's internal response (never sent to the browser as-is). */
interface InternalStartResponse extends auth.StartImpersonationResponse {
  setCookie: string;
}

export async function startImpersonationHandler(c: Ctx): Promise<Response> {
  const requestId = getRequestId(c);
  const svc = createServices(c.env);
  const authed = authedActor(c);
  const token = extractToken(c.req.raw.headers);
  if (!token) throw errors.unauthenticated("missing bearer/cookie token");

  const ctx: RequestContext = { requestId, userId: authed.userId, caller: "api-gateway" };
  const targetId = c.req.param("userId") ?? "";
  const res = await svc.authSvc.post<InternalStartResponse, Record<string, never>>(
    ctx,
    `/internal/admin/users/${encodeURIComponent(targetId)}/impersonation`,
    {},
    { headers: { authorization: `Bearer ${token}` } },
  );
  c.header("set-cookie", res.setCookie);
  const body: auth.StartImpersonationResponse = { impersonation: res.impersonation };
  return c.json(body);
}
