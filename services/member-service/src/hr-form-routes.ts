// 面談申し込みフォームのルート (app.ts から registerHrInterviewFormRoutes で1行登録)。
// 認可はここに書かない: 各ルートの規則は policy-table.ts の行 (人事 / 公開 面談申し込みフォーム)。
//   /members/hr/interview-form*            人事アプリの画面 (閲覧 + hr:read / 編集 + hr:write)
//   /members/internal/hr/interview-form    公開ページ (gateway の PUBLIC ルートが s2s で転送・INTERNAL)
import type { Context, Hono } from "hono";
import type { RequestContext } from "@dub/http";
import { errors } from "@dub/errors";
import type { hrForm } from "@dub/types";
import { PUBLIC_INTERVIEW_FORM_ACTOR, type HrFormService } from "./hr-form-service";
import type { ReqCtx } from "./service";

function requestIdOf(c: Context): string {
  const ctx = c.get("dubCtx") as RequestContext | undefined;
  return ctx?.requestId ?? c.req.header("x-dub-request-id") ?? "";
}

/** 表が鍵を要求するルートでは gate が発信者を保証する (無ければ 401 済み)。 */
function reqCtx(c: Context): ReqCtx {
  const userId = c.get("userId") as string | undefined;
  if (!userId) throw errors.unauthenticated("x-dub-user-id absent");
  return { requestId: requestIdOf(c), userId };
}

/** 公開ページ経由 (INTERNAL・ログイン無し) は system principal に帰属させる。 */
function publicCtx(c: Context): ReqCtx {
  return { requestId: requestIdOf(c), userId: (c.get("userId") as string | undefined) ?? PUBLIC_INTERVIEW_FORM_ACTOR };
}

async function readJson<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw errors.validationFailed([{ field: "body", reason: "invalid_json" }]);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerHrInterviewFormRoutes(app: Hono<any>, svc: HrFormService): void {
  // ---- 人事アプリ: フォームの編集・回答一覧・代理入力 ----
  app.get("/members/hr/interview-form", async (c) => c.json(await svc.getForm()));
  app.put("/members/hr/interview-form", async (c) => {
    const body = await readJson<hrForm.SaveInterviewFormRequest>(c);
    return c.json(await svc.saveForm(reqCtx(c), body));
  });
  app.get("/members/hr/interview-form/responses", async (c) => {
    const applicantId = c.req.query("applicantId")?.trim() || undefined;
    return c.json(await svc.listResponses(applicantId));
  });
  app.post("/members/hr/interview-form/responses", async (c) => {
    const body = await readJson<hrForm.SubmitInterviewFormRequest>(c);
    return c.json(await svc.submit(reqCtx(c), body, "staff"), 201);
  });

  // ---- 公開ページ (gateway GET/POST /api/v1/public/hr-interview-form → ここ, s2s のみ) ----
  app.get("/members/internal/hr/interview-form", async (c) => c.json(await svc.getPublicForm()));
  app.post("/members/internal/hr/interview-form", async (c) => {
    const body = await readJson<hrForm.SubmitInterviewFormRequest>(c);
    const res = await svc.submit(publicCtx(c), body, "public");
    // 公開側には誰が応募済みかを返さない (gateway もさらに accepted だけに絞る)。
    return c.json({ accepted: true, responseId: res.response.id }, 201);
  });
}
