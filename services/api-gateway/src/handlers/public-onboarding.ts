// GET /api/v1/public/onboarding — public (unauthenticated) オンボーディング案内.
// 新しく入った人は Dub のアカウントをまだ持っていないので、案内ページはログイン不要で読める
// 必要がある。gateway が member-service の internal route へ s2s で取りに行き、項目
// (管理者が公開前提で書いた案内文) だけを返す。読み取り専用で書き込みは無い。
import type { Context } from "hono";
import type { member } from "@dub/types";
import type { RequestContext } from "@dub/http";
import type { GatewayEnv } from "../env";
import type { GatewayVariables } from "../context";
import { getRequestId } from "../context";
import { createServices } from "../services";

const SYSTEM_ACTOR = "system:public-onboarding";

export async function publicOnboardingHandler(
  c: Context<{ Bindings: GatewayEnv; Variables: GatewayVariables }>,
): Promise<Response> {
  const svc = createServices(c.env);
  const ctx: RequestContext = { requestId: getRequestId(c), userId: SYSTEM_ACTOR, caller: "api-gateway" };
  const res = await svc.member.get<member.ListOnboardingItemsResponse>(ctx, "/members/internal/onboarding");
  const body: member.ListOnboardingItemsResponse = { items: res.items };
  return c.json(body);
}
