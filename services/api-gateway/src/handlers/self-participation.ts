// Self 参加届 composition handlers (アカウント設定 → 参加情報). member-service's self route
// is internal-only (/members/internal/*, 404'd at the edge), so a member reading/editing
// their OWN 参加届 can NOT ride the transparent proxy. The gateway OWNS these two paths,
// authenticates the caller, and forwards to member-service as a genuine s2s call
// (x-dub-internal + the caller's identity x-dub-user-id). Session-scoped to that user —
// member-service resolves the 届 via the identity link to their member_people row:
//
//   GET  /api/v1/me/participation   read self 参加届   (session required)
//   POST /api/v1/me/participation   edit self 参加届   (session required)
import type { Context } from "hono";
import type { GatewayEnv } from "../env";
import type { GatewayVariables } from "../context";
import type { member } from "@dub/types";
import type { RequestContext } from "@dub/http";
import { createServices } from "../services";
import { authenticate } from "../auth";
import { getRequestId } from "../context";

type Ctx = Context<{ Bindings: GatewayEnv; Variables: GatewayVariables }>;

/** GET /api/v1/me/participation — the signed-in user reads their OWN 参加届. */
export async function getSelfParticipationHandler(c: Ctx): Promise<Response> {
  const requestId = getRequestId(c);
  const svc = createServices(c.env);
  const auth = await authenticate(svc.auth, { requestId }, c.req.raw.headers);
  const ctx: RequestContext = { requestId, userId: auth.userId, caller: "api-gateway" };
  const body = await svc.member.get<member.SelfParticipation>(ctx, "/members/internal/me/participation");
  return c.json(body);
}

/** POST /api/v1/me/participation — the signed-in user patches their OWN 参加届. */
export async function updateSelfParticipationHandler(c: Ctx): Promise<Response> {
  const requestId = getRequestId(c);
  const svc = createServices(c.env);
  const auth = await authenticate(svc.auth, { requestId }, c.req.raw.headers);
  const ctx: RequestContext = { requestId, userId: auth.userId, caller: "api-gateway" };
  const input = await c.req
    .json<member.SelfParticipationUpdateRequest>()
    .catch(() => ({}) as member.SelfParticipationUpdateRequest);
  const body = await svc.member.post<member.SelfParticipation, member.SelfParticipationUpdateRequest>(
    ctx,
    "/members/internal/me/participation",
    input,
  );
  return c.json(body);
}
