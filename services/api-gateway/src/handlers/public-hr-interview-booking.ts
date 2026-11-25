// POST /api/v1/public/hr-interview-booking/{view,book} — 面談の日程選択ページ用。応募者はアカウントを
// 持たないので未ログインで呼ぶ。資格情報はメールで渡したトークンだけで、URL に載らないよう body で受ける。
// 判定はすべて member-service が行い、gateway は決まった項目だけを s2s で転送する。
import type { Context } from "hono";
import type { hrInterview } from "@dub/types";
import { errors } from "@dub/errors";
import type { RequestContext } from "@dub/http";
import type { GatewayEnv } from "../env";
import type { GatewayVariables } from "../context";
import { getRequestId } from "../context";
import { createServices } from "../services";

// member-service が予約の履歴を帰属させる system principal と同じ値。
const SYSTEM_ACTOR = "system:public-hr-interview-booking";

type Ctx = Context<{ Bindings: GatewayEnv; Variables: GatewayVariables }>;

export function publicHrInterviewBookingHandler(action: "view" | "book") {
  return async (c: Ctx): Promise<Response> => {
    const raw = (await c.req.json().catch(() => null)) as Partial<hrInterview.PublicBookingRequest> | null;
    const token = typeof raw?.token === "string" ? raw.token : "";
    const slotId = typeof raw?.slotId === "string" ? raw.slotId : "";
    if (!token) throw errors.validationFailed([{ field: "token", reason: "required" }]);
    if (action === "book" && !slotId) throw errors.validationFailed([{ field: "slotId", reason: "required" }]);
    const svc = createServices(c.env);
    const ctx: RequestContext = { requestId: getRequestId(c), userId: SYSTEM_ACTOR, caller: "api-gateway" };
    const body = action === "book" ? { token, slotId } : { token };
    const res = await svc.member.post<hrInterview.PublicInterviewBooking, typeof body>(
      ctx,
      `/members/internal/hr/interview-booking/${action}`,
      body,
    );
    return c.json(res);
  };
}
