// 参加届からのアカウント発行 (人事向け). One call does what IssueMailDialog used to do in
// three, without the caller holding mail:admin / identity:admin / ロール管理の編集:
//
//   POST /api/v1/admin/participation/:participationId/onboard-account   (members:onboard_mail)
//
//   1. member-service   onboard-target: 参加届に紐付いた追加済の名簿行で、アカウントがまだ無い人
//   2. identity-roster  lookup / mail-gateway lookup: アカウントもアドレスもまだ無いこと (何も作らない)
//   3. mail-gateway     アドレス発行
//   4. identity-roster  招待中アカウントを作る。ロールは identity-roster が一般メンバーに固定
//   5. member-service   onboard-link: 再確認してから名簿と紐付け (在籍なら有効化される)
//   6. (任意) auth-service 初期パスワード (作成直後・未設定の時だけ) + 案内メール (system send)
//
// Consistency: 3-5 are all-or-nothing by compensation, so a retry starts clean with the same
// address. Step 2 proves neither the address nor the account existed, so after an UNKNOWN
// outcome (timeout / 5xx) whatever now exists under that address is ours and is looked up by
// address and undone; a definitive 4xx created nothing. Step 5 is re-checked once (the link is
// idempotent) before undoing, so a link that committed but lost its response is kept. The
// account is undone before the address, and the address is kept whenever the account could not
// be undone (never an account without its mail). Leftovers are logged and returned in the
// error details for an admin. Step 6 is best-effort: the account already works.
//
// Reserved local parts (system senders / archive / RFC 2142 role addresses) are refused: those
// addresses would hand system mail to whoever holds the account.
//
// Nothing here accepts a role or a target account from the caller: the role is fixed in
// identity-roster and the target is derived from the 参加届, so an existing account can
// never be changed through this endpoint.
import type { Context } from "hono";
import { DubError, errors, isDubError } from "@dub/errors";
import type { RequestContext } from "@dub/http";
import { consoleSink } from "@dub/observability";
import type { identity, member } from "@dub/types";
import type { GatewayEnv } from "../env";
import type { GatewayVariables } from "../context";
import { getRequestId } from "../context";
import { createServices, type GatewayServices } from "../services";
import { authedActor } from "../policy";
import { DEFAULT_APP_BASE_URL, DEVHUB_MAIL_DOMAIN, sendAccountMailAsSystem } from "./account-mail";

type Ctx = Context<{ Bindings: GatewayEnv; Variables: GatewayVariables }>;

/** Same alphabet mail-gateway accepts for an issued local part. */
const LOCAL_PART_RE = /^[a-z0-9._%+-]{1,64}$/;
/** System / role addresses never handed to a person through this endpoint. */
export const RESERVED_LOCAL_PARTS: ReadonlySet<string> = new Set([
  "info", "archive", "admin", "administrator", "root", "postmaster", "hostmaster", "webmaster", "abuse",
  "security", "noreply", "no-reply", "mailer-daemon", "support", "contact", "hello", "staff", "hr", "system",
]);

/** Validate a requested @developershub.jp local part (shared by every onboard flow). */
export function parseLocalPart(v: unknown): string {
  const localPart = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!LOCAL_PART_RE.test(localPart)) {
    throw errors.validationFailed([{ field: "localPart", reason: "invalid" }], "メールアドレスは半角英小文字・数字と . _ % + - で入力してください");
  }
  if (RESERVED_LOCAL_PARTS.has(localPart)) {
    throw errors.validationFailed([{ field: "localPart", reason: "reserved" }], `${localPart}@ は運営用のアドレスなので発行できません`);
  }
  return localPart;
}

function parseBody(raw: unknown): { localPart: string; sendAccountMail: boolean } {
  const o = (raw ?? {}) as Partial<member.OnboardAccountRequest>;
  return { localPart: parseLocalPart(o.localPart), sendAccountMail: o.sendAccountMail === true };
}

/** A 4xx from a callee means it refused before creating anything; anything else is unknown. */
function isDefinitive(err: unknown): boolean {
  return isDubError(err) && err.status >= 400 && err.status < 500;
}

function furiganaOf(p: member.Participation): string | undefined {
  const kana = [p.lastNameKana, p.firstNameKana].map((v) => (v ?? "").trim()).filter(Boolean).join(" ");
  return kana || p.nameKana?.trim() || undefined;
}

interface Made {
  address: string;
  /** Known account id, or "lookup" when step 4's outcome is unknown. */
  account?: string | "lookup";
}

/** Undo in reverse; returns what could NOT be undone. Never throws. */
async function compensate(svc: GatewayServices, ctx: RequestContext, made: Made): Promise<string[]> {
  let uid: string | undefined = made.account === "lookup" ? undefined : made.account;
  if (made.account === "lookup") {
    try {
      uid = (await svc.identity.post<{ user: identity.IdentityUser | null }>(ctx, "/internal/users/lookup", { email: made.address })).user?.id;
    } catch (err) {
      logLeftover(ctx, "lookup-account", err);
      return [`account:${made.address}`, `address:${made.address}`];
    }
  }
  if (uid) {
    try {
      await svc.identity.post(ctx, `/internal/users/${encodeURIComponent(uid)}/discard-onboard`, {});
    } catch (err) {
      logLeftover(ctx, "discard-onboard", err);
      // keep the address: an account must never be left without its mail
      return [`account:${uid}`, `address:${made.address}`];
    }
  }
  try {
    await svc.mail.post(ctx, "/internal/email-routing/issued-addresses/revoke", { address: made.address }, { timeoutMs: ISSUE_TIMEOUT_MS });
  } catch (err) {
    logLeftover(ctx, "revoke-address", err);
    return [`address:${made.address}`];
  }
  return [];
}

function logLeftover(ctx: RequestContext, step: string, err: unknown): void {
  consoleSink({
    level: "error",
    message: "api-gateway: onboard-account rollback failed",
    service: "api-gateway",
    requestId: ctx.requestId,
    fields: { step, error: err instanceof Error ? err.message : String(err) },
  });
}

/** Rethrow the original failure, or a partial-failure error when cleanup left something. */
async function failAfter(svc: GatewayServices, ctx: RequestContext, made: Made, err: unknown): Promise<never> {
  const left = await compensate(svc, ctx, made);
  if (left.length === 0) throw err;
  throw new DubError(ONBOARD_PARTIAL, "途中で失敗し、作成済みの分を戻せませんでした。管理者に連絡してください", {
    status: 502,
    details: left.map((l) => ({ field: "leftover", reason: "not_rolled_back", message: l })),
  });
}

/**
 * Steps 2-5 shared by every onboard flow (参加届 / 面談結果の合格): check the address is free, issue
 * it, create the invited account (role fixed by identity-roster), then `link` it to the roster.
 * `link` must be idempotent server-side for the same identityUserId. All-or-nothing by compensation.
 */
export async function issueLinkedAccount<L>(
  svc: GatewayServices,
  ctx: RequestContext,
  a: { address: string; localPart: string; displayName: string; furigana?: string | undefined; link: (identityUserId: string) => Promise<L> },
): Promise<{ user: identity.IdentityUser; member: L }> {
  const { address, localPart } = a;
  // 2: checks only — nothing is created before all pass.
  const existing = await svc.identity.post<{ user: identity.IdentityUser | null }>(ctx, "/internal/users/lookup", { email: address });
  if (existing.user) {
    throw new DubError("GATEWAY_ONBOARD_EMAIL_EXISTS", `${address} のアカウントは既にあります`, { status: 409 });
  }
  const taken = await svc.mail.post<{ taken: boolean }>(ctx, "/internal/email-routing/issued-addresses/lookup", { address }, { timeoutMs: ISSUE_TIMEOUT_MS });
  if (taken.taken) {
    throw new DubError("MAIL_EMAIL_ROUTING_CONFLICT", "このアドレスは既に使われています", { status: 409 });
  }

  // 3. the address
  const made: Made = { address };
  try {
    const issued = await svc.mail.post<{ id: string; address: string }>(ctx, "/internal/email-routing/issued-addresses", { localPart }, { timeoutMs: ISSUE_TIMEOUT_MS });
    if (issued.address.toLowerCase() !== address) throw errors.internal(`issued ${issued.address}, expected ${address}`);
  } catch (err) {
    if (isDefinitive(err)) throw err;
    return failAfter(svc, ctx, made, err);
  }

  // 4. the account (role fixed by identity-roster)
  let user: identity.IdentityUser;
  try {
    user = (
      await svc.identity.post<{ user: identity.IdentityUser }>(ctx, "/internal/users/onboard", {
        email: address,
        displayName: a.displayName,
        ...(a.furigana ? { furigana: a.furigana } : {}),
      })
    ).user;
  } catch (err) {
    return failAfter(svc, ctx, isDefinitive(err) ? made : { ...made, account: "lookup" }, err);
  }
  made.account = user.id;

  // 5. the roster link — idempotent server-side, so one re-check settles a lost response
  const link = (): Promise<L> => a.link(user.id);
  let linked: L;
  try {
    linked = await link();
  } catch (err) {
    try {
      if (isDefinitive(err)) throw err;
      linked = await link();
    } catch {
      return failAfter(svc, ctx, made, err);
    }
  }

  return { user, member: linked };
}

export const ONBOARD_PARTIAL = "GATEWAY_ONBOARD_PARTIAL";
/** mail-gateway issue = CF list + D1 + CF create + confirmation send in one call. */
const ISSUE_TIMEOUT_MS = 25_000;

/** POST /api/v1/admin/participation/:participationId/onboard-account */
export async function participationOnboardHandler(c: Ctx): Promise<Response> {
  const requestId = getRequestId(c);
  const svc = createServices(c.env);
  // members:onboard_mail was already enforced by the gate (POLICY_TABLE).
  const authed = authedActor(c);
  const ctx: RequestContext = { requestId, userId: authed.userId, caller: "api-gateway" };
  const pid = encodeURIComponent(c.req.param("participationId") ?? "");
  const { localPart, sendAccountMail } = parseBody(await c.req.json().catch(() => null));
  const address = `${localPart}@${DEVHUB_MAIL_DOMAIN}`;

  // 1. the target (参加届に紐付いた追加済の名簿行で、アカウントがまだ無い人)
  const target = await svc.member.get<member.OnboardTargetResponse>(ctx, `/members/internal/participation/${pid}/onboard-target`);
  const { user, member: linked } = await issueLinkedAccount(svc, ctx, {
    address,
    localPart,
    displayName: target.participation.name,
    furigana: furiganaOf(target.participation),
    link: (identityUserId) =>
      svc.member.post<member.Member>(ctx, `/members/internal/participation/${pid}/onboard-link`, { identityUserId }),
  });

  // 6. the account-issue mail (best-effort)
  // 案内メールの宛先は名簿の Gmail (ユーザー名簿の account-mail と同じ)。
  const to = (linked.gmail ?? "").trim() || null;
  let sent = false;
  if (sendAccountMail && to) {
    try {
      const { password } = await svc.authSvc.post<{ ok: true; password: string }>(
        ctx,
        `/internal/onboard/users/${encodeURIComponent(user.id)}/initial-password`,
        {},
      );
      await sendAccountMailAsSystem(svc, requestId, {
        targetId: user.id,
        to,
        content: { name: linked.name, appUrl: c.env.APP_BASE_URL || DEFAULT_APP_BASE_URL, loginEmail: address, password, generated: true },
      });
      sent = true;
    } catch (err) {
      consoleSink({
        level: "warn",
        message: "api-gateway: onboard-account mail not sent",
        service: "api-gateway",
        requestId,
        fields: { identityUserId: user.id, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  const res: member.OnboardAccountResponse = {
    address,
    identityUserId: user.id,
    member: linked,
    accountMail: { requested: sendAccountMail, sent, to },
  };
  return c.json(res, 201);
}
