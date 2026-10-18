// アカウント発行メール (account-issue mail). When an @developershub.jp login is linked to an
// 運営メンバー, the admin can send that member ONE mail with everything needed to sign in:
//
//   POST /api/v1/admin/users/:userId/account-mail   (identity:admin — POLICY_TABLE)
//
//   1. member-service  reverse lookup -> member.gmail (to) + name
//   2. identity-roster the login account -> email (login id, cc)
//   3. auth-service    current password, or (only when none is viewable) issue one with
//                      mustChange — the same two internal routes the admin password UI uses
//   4. mail-gateway    /send as a SYSTEM call (no user id: the admin need not hold mail:send)
//
// Steps 1-2 run before any credential is touched, so a member without a Gmail never gets a
// password silently (re)issued. The password is never logged nor returned to the caller.
import type { Context } from "hono";
import { errors, isDubError } from "@dub/errors";
import type { RequestContext } from "@dub/http";
import type { auth, identity, mail, member } from "@dub/types";
import type { GatewayEnv } from "../env";
import type { GatewayVariables } from "../context";
import { getRequestId } from "../context";
import { createServices } from "../services";
import { authedActor } from "../policy";

type Ctx = Context<{ Bindings: GatewayEnv; Variables: GatewayVariables }>;

/** The cc / login must be a Developers Hub address — otherwise the three are not linked yet. */
export const DEVHUB_MAIL_DOMAIN = "developershub.jp";
export const DEFAULT_APP_BASE_URL = "https://app.developershub.jp";
export const ACCOUNT_MAIL_SUBJECT = "【Developers Hub】アカウント発行のお知らせ";
/** auth-service: no decryptable copy of the password exists (never set / legacy hash). */
const PASSWORD_NOT_VIEWABLE = "AUTH_PASSWORD_NOT_VIEWABLE";

export interface AccountMailContent {
  name: string;
  appUrl: string;
  loginEmail: string;
  password: string;
  /** true = freshly issued (must be changed on first login); false = the current one. */
  generated: boolean;
}

/** Pure: the plain-text body of the account-issue mail. */
export function buildAccountMailBody(c: AccountMailContent): string {
  return [
    `${c.name} さん`,
    "",
    "Developers Hub の運営アプリのアカウント情報をお送りします。",
    "次の情報でログインしてください。",
    "",
    `アプリ URL: ${c.appUrl}`,
    `ログインメールアドレス: ${c.loginEmail}`,
    `${c.generated ? "初期パスワード" : "パスワード"}: ${c.password}`,
    "",
    ...(c.generated ? ["初回ログイン時にパスワードの変更をお願いします。", ""] : []),
    `このメールは ${c.loginEmail} にも CC しています。`,
    "",
    "Developers Hub 運営",
  ].join("\n");
}

/** POST /api/v1/admin/users/:userId/account-mail — send the login info to the member's Gmail. */
export async function adminSendAccountMailHandler(c: Ctx): Promise<Response> {
  const requestId = getRequestId(c);
  const svc = createServices(c.env);
  // identity:admin was already enforced by the gate (POLICY_TABLE).
  const authed = authedActor(c);
  const ctx: RequestContext = { requestId, userId: authed.userId, caller: "api-gateway" };
  const targetId = c.req.param("userId") ?? "";
  const enc = encodeURIComponent(targetId);

  const { member: linked } = await svc.member.get<{ member: member.Member | null }>(ctx, `/members/people/by-identity/${enc}`);
  if (!linked) {
    throw errors.validationFailed([{ field: "userId", reason: "not_linked" }], "このアカウントに紐付いた運営メンバーがいません");
  }
  const gmail = (linked.gmail ?? "").trim();
  if (!gmail) {
    throw errors.validationFailed([{ field: "gmail", reason: "required" }], "運営メンバーの Gmail が登録されていません");
  }
  const user = await svc.identity.get<identity.IdentityUser>(ctx, `/users/${enc}`);
  const loginEmail = (user.email ?? "").trim();
  if (!loginEmail.toLowerCase().endsWith(`@${DEVHUB_MAIL_DOMAIN}`)) {
    throw errors.validationFailed([{ field: "email", reason: "not_devhub" }], "ログインアカウントが @developershub.jp のアドレスではありません");
  }

  const pwPath = `/internal/admin/users/${enc}/password`;
  let password: string;
  let passwordSource: auth.AdminSendAccountMailResponse["passwordSource"];
  try {
    password = (await svc.authSvc.get<auth.AdminViewPasswordResponse>(ctx, pwPath)).password;
    passwordSource = "existing";
  } catch (err) {
    if (!(isDubError(err) && err.code === PASSWORD_NOT_VIEWABLE)) throw err;
    const issued = await svc.authSvc.post<auth.AdminSetPasswordResponse, auth.AdminSetPasswordRequest>(ctx, pwPath, {
      generate: true,
      mustChange: true,
    });
    if (!issued.password) throw errors.internal("password was not generated");
    password = issued.password;
    passwordSource = "generated";
  }

  const appUrl = c.env.APP_BASE_URL || DEFAULT_APP_BASE_URL;
  const req: mail.SendMailRequest = {
    to: [{ email: gmail, name: linked.name }],
    cc: [{ email: loginEmail }],
    subject: ACCOUNT_MAIL_SUBJECT,
    textBody: buildAccountMailBody({ name: linked.name, appUrl, loginEmail, password, generated: passwordSource === "generated" }),
  };
  // System send: without a userId mail-gateway does not require the admin to hold mail:send.
  const sysCtx: RequestContext = { requestId, caller: "api-gateway" };
  const sent = await svc.mail.post<mail.SendMailResponse, mail.SendMailRequest>(sysCtx, "/send", req, {
    idempotencyKey: `account-mail:${targetId}:${requestId}`,
  });

  const res: auth.AdminSendAccountMailResponse = {
    ok: true,
    to: gmail,
    cc: loginEmail,
    appUrl,
    passwordSource,
    messageId: sent.messageId,
  };
  return c.json(res);
}
