// 面談結果の登録 (人事アプリ「面談結果を登録」):
//
//   POST /api/v1/admin/hr/applicants/:applicantId/interview-result   (hr:write + members:onboard_mail)
//
//   1. member-service claim:  応募者ごとに 1 件の結果を占有 (UNIQUE)。登録済みなら何もせずそれを返す。
//   2. (合格のみ・未発行なら) 参加届からの発行と同じ issueLinkedAccount:
//        アドレス → 招待中アカウント (ロールは identity-roster が一般メンバーに固定) → link
//        (member-service が名簿の行を作って結び、応募者を 採用 にする)。
//   3. (合格のみ・発行した時だけ) 初期パスワード + 既存の「アカウント発行のお知らせ」を応募者のメールへ (best-effort)。
//   4. member-service complete: 不合格なら 不合格 に。合否のメールを 1 通 (冪等キー = 結果 id) 送って完了。
//
// 途中で失敗したら release で占有を手放す (発行済みの記録は残るので、もう一度押すと続きから)。
// 二度押し: 2 本目は claim で 409 (処理中) か、完了済みの結果 (alreadyRegistered) になる。
import type { Context } from "hono";
import { errors } from "@dub/errors";
import type { RequestContext } from "@dub/http";
import { consoleSink } from "@dub/observability";
import { hrResult, type hr } from "@dub/types";
import type { GatewayEnv } from "../env";
import type { GatewayVariables } from "../context";
import { getRequestId } from "../context";
import { createServices } from "../services";
import { authedActor } from "../policy";
import { DEFAULT_APP_BASE_URL, DEVHUB_MAIL_DOMAIN, sendAccountMailAsSystem } from "./account-mail";
import { issueLinkedAccount, parseLocalPart } from "./participation-onboard";

type Ctx = Context<{ Bindings: GatewayEnv; Variables: GatewayVariables }>;

type ParsedBody = Omit<hrResult.RegisterInterviewResultRequest, "localPart" | keyof hrResult.PassPlacement> & {
  localPart: string | null;
  placement: hrResult.PassPlacement;
};

/** 合格の所属 (チーム・上長) はそのまま member-service に渡す (存在の確認は claim が発行前に行う)。 */
function placementOf(o: Partial<hrResult.RegisterInterviewResultRequest>): hrResult.PassPlacement {
  if (o.decision !== "pass") return {};
  return {
    ...(o.teamIds !== undefined ? { teamIds: o.teamIds } : {}),
    ...(o.leaderId !== undefined ? { leaderId: o.leaderId } : {}),
  };
}

function parseBody(raw: unknown): ParsedBody {
  const o = (raw ?? {}) as Partial<hrResult.RegisterInterviewResultRequest>;
  if (!hrResult.isInterviewDecision(o.decision)) throw errors.validationFailed([{ field: "decision", reason: "invalid" }]);
  if (typeof o.reason !== "string" || o.reason.trim() === "") throw errors.validationFailed([{ field: "reason", reason: "required" }]);
  return {
    decision: o.decision,
    reason: o.reason,
    includeReasonInMail: o.includeReasonInMail === true,
    localPart: o.decision === "pass" ? parseLocalPart(o.localPart) : null,
    placement: placementOf(o),
  };
}

/** POST /api/v1/admin/hr/applicants/:applicantId/interview-result */
export async function hrInterviewResultHandler(c: Ctx): Promise<Response> {
  const requestId = getRequestId(c);
  const svc = createServices(c.env);
  const authed = authedActor(c); // hr:write + members:onboard_mail は gate が検査済み
  const ctx: RequestContext = { requestId, userId: authed.userId, caller: "api-gateway" };
  const aid = encodeURIComponent(c.req.param("applicantId") ?? "");
  const base = `/members/internal/hr/applicants/${aid}/interview-result`;
  const body = parseBody(await c.req.json().catch(() => null));

  const claim = await svc.member.post<hrResult.ClaimInterviewResultResponse, hrResult.ClaimInterviewResultRequest>(ctx, `${base}/claim`, {
    decision: body.decision,
    reason: body.reason,
    includeReasonInMail: body.includeReasonInMail === true,
    ...body.placement,
  });
  if (!claim.proceed) {
    const res: hrResult.RegisterInterviewResultResponse = { result: claim.result, applicant: claim.applicant, alreadyRegistered: true, accountMailSent: false };
    return c.json(res, 200);
  }

  let accountMailSent = false;
  try {
    const r = claim.result;
    if (r.decision === "pass" && !r.issuedIdentityUserId) {
      const address = `${body.localPart}@${DEVHUB_MAIL_DOMAIN}`;
      const { user } = await issueLinkedAccount(svc, ctx, {
        address,
        localPart: body.localPart as string,
        displayName: claim.applicant.name,
        furigana: claim.applicant.nameKana ?? undefined,
        link: (identityUserId) =>
          svc.member.post<hr.Applicant, hrResult.LinkInterviewResultRequest>(ctx, `${base}/link`, { identityUserId, address, ...body.placement }),
      });
      accountMailSent = await sendLoginMail(c, svc, ctx, { userId: user.id, to: claim.applicant.email, name: claim.applicant.name, address });
    } else if (r.decision === "pass" && r.issuedIdentityUserId && r.issuedAddress) {
      // 再試行: アカウントは発行済み。名簿との紐付けまで済ませる (冪等)。
      await svc.member.post<hr.Applicant, hrResult.LinkInterviewResultRequest>(ctx, `${base}/link`, {
        identityUserId: r.issuedIdentityUserId,
        address: r.issuedAddress,
        ...body.placement,
      });
    }
    const done = await svc.member.post<hrResult.CompleteInterviewResultResponse, hrResult.CompleteInterviewResultRequest>(ctx, `${base}/complete`, {
      accountMailSent,
    });
    const res: hrResult.RegisterInterviewResultResponse = { ...done, alreadyRegistered: false, accountMailSent };
    return c.json(res, 201);
  } catch (err) {
    await svc.member.post(ctx, `${base}/release`, {}).catch(() => undefined);
    throw err;
  }
}

/** 既存のアカウント発行メール (初期パスワード) を応募者の個人メールへ。失敗してもアカウントは使えるので best-effort。 */
async function sendLoginMail(
  c: Ctx,
  svc: ReturnType<typeof createServices>,
  ctx: RequestContext,
  a: { userId: string; to: string | null; name: string; address: string },
): Promise<boolean> {
  if (!a.to) return false;
  try {
    const { password } = await svc.authSvc.post<{ ok: true; password: string }>(
      ctx,
      `/internal/onboard/users/${encodeURIComponent(a.userId)}/initial-password`,
      {},
    );
    await sendAccountMailAsSystem(svc, ctx.requestId, {
      targetId: a.userId,
      to: a.to,
      content: { name: a.name, appUrl: c.env.APP_BASE_URL || DEFAULT_APP_BASE_URL, loginEmail: a.address, password, generated: true },
    });
    return true;
  } catch (err) {
    consoleSink({
      level: "warn",
      message: "api-gateway: hr interview-result account mail not sent",
      service: "api-gateway",
      requestId: ctx.requestId,
      fields: { identityUserId: a.userId, error: err instanceof Error ? err.message : String(err) },
    });
    return false;
  }
}
