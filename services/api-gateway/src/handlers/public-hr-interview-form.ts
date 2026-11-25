// GET|POST /api/v1/public/hr-interview-form — 人事アプリの「面談申し込みフォーム」の公開ページ用。
// 申し込む人はまだ Dub のアカウントを持っていないので未ログインで読めて送れる必要がある。gateway が
// member-service の internal route へ s2s (x-dub-internal + system actor) で転送する。
//  - GET : 人事が編集した質問 (公開前提) だけを返す。短くキャッシュして D1 読み取りを抑える。
//  - POST: bot 対策を重ねてから転送する。常時: 全体のレート制限 (middleware)。加えて
//          ① 囮フィールド `website` (人には見えない入力欄) が埋まっていたら転送せず accepted を返す
//          ② Turnstile は参加届と同じく、secret があり token が来たとき (widget を出したとき) だけ検証する。
//    応答は { accepted } のみで、誰が応募済みかは漏らさない。回答の中身の検証は member-service
//    (@dub/types hrForm.validateAnswers) が行い、400 の項目エラーはそのまま返す (フォームに表示するため)。
import type { Context } from "hono";
import type { hrForm } from "@dub/types";
import { errors } from "@dub/errors";
import type { RequestContext } from "@dub/http";
import type { GatewayEnv } from "../env";
import type { GatewayVariables } from "../context";
import { getRequestId, gatewayError, GATEWAY_TURNSTILE_FAILED } from "../context";
import { createServices } from "../services";
import { createTurnstileVerifier, type TurnstileVerifier } from "../turnstile";

// member-service が回答を帰属させる system principal と同じ値。
const SYSTEM_ACTOR = "system:public-hr-interview-form";

type Ctx = Context<{ Bindings: GatewayEnv; Variables: GatewayVariables }>;

export async function publicHrInterviewFormGetHandler(c: Ctx): Promise<Response> {
  const svc = createServices(c.env);
  const ctx: RequestContext = { requestId: getRequestId(c), userId: SYSTEM_ACTOR, caller: "api-gateway" };
  const res = await svc.member.get<hrForm.PublicInterviewForm>(ctx, "/members/internal/hr/interview-form");
  const body: hrForm.PublicInterviewForm = {
    title: res.title,
    description: res.description,
    questions: res.questions,
    accepting: res.accepting,
  };
  c.header("Cache-Control", "public, max-age=30");
  return c.json(body);
}

export function createPublicHrInterviewFormSubmitHandler(override?: TurnstileVerifier) {
  return async (c: Ctx): Promise<Response> => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw errors.validationFailed([{ field: "body", reason: "invalid_json" }]);
    }
    const b = (raw ?? {}) as Partial<hrForm.PublicSubmitInterviewFormRequest>;
    if (b.answers === null || typeof b.answers !== "object" || Array.isArray(b.answers)) {
      throw errors.validationFailed([{ field: "answers", reason: "required" }]);
    }
    const accepted: hrForm.PublicSubmitInterviewFormResponse = { accepted: true };

    // 囮: 人には見えない欄。埋まっている = bot。成功を装って何もしない (bot に判定を学習させない)。
    if (typeof b.website === "string" && b.website.trim() !== "") return c.json(accepted);

    const token = typeof b.turnstileToken === "string" && b.turnstileToken.trim() !== "" ? b.turnstileToken.trim() : null;
    const remoteIp = c.req.header("cf-connecting-ip") ?? null;
    if (override) {
      if (!(await override(token ?? "", remoteIp))) throw gatewayError(GATEWAY_TURNSTILE_FAILED, "Turnstile verification failed", 403);
    } else if (c.env.TURNSTILE_SECRET && token) {
      const ok = await createTurnstileVerifier(c.env.TURNSTILE_SECRET)(token, remoteIp);
      if (!ok) throw gatewayError(GATEWAY_TURNSTILE_FAILED, "Turnstile verification failed", 403);
    }

    const svc = createServices(c.env);
    const ctx: RequestContext = { requestId: getRequestId(c), userId: SYSTEM_ACTOR, caller: "api-gateway" };
    await svc.member.post<unknown, hrForm.SubmitInterviewFormRequest>(ctx, "/members/internal/hr/interview-form", {
      answers: b.answers,
    });
    return c.json(accepted);
  };
}
