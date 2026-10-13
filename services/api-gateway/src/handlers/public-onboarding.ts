// GET /api/v1/public/onboarding — public (unauthenticated) オンボーディング案内.
// 新しく入った人は Dub のアカウントをまだ持っていないので、案内ページはログイン不要で読める
// 必要がある。gateway が member-service の internal route へ s2s で取りに行き、項目・
// チームの選択肢 (id/名前/色)・ミーティング案内 (管理者が公開前提で書いたもの) だけを返す。
// 読み取り専用で書き込みは無い。
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
  const res = await svc.member.get<member.OnboardingGuide>(ctx, "/members/internal/onboarding");
  const body: member.OnboardingGuide = { items: res.items, teams: res.teams, meetings: res.meetings };
  // 管理者が書く静的な案内なので短くキャッシュし、閲覧のたびの D1 読み取りを抑える。
  c.header("Cache-Control", "public, max-age=60");
  return c.json(body);
}
