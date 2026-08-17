// POST /api/v1/public/participation — public (unauthenticated) 参加届 receipt.
// A participant files their own 参加届 without signing in. The gateway validates the
// payload, optionally verifies Turnstile (bot defense, when a secret is configured or
// a verifier is injected), is rate-limited by the global middleware, then forwards to
// member-service's internal-only route as a genuine s2s call (x-dub-internal + a system
// actor). The response is deliberately minimal — { accepted, matchKind } — so an
// unauthenticated caller learns nothing about who is on the roster.
import type { Context } from "hono";
import type { GatewayEnv } from "../env";
import type { GatewayVariables } from "../context";
import type { gateway, member } from "@dub/types";
import type { FieldError } from "@dub/errors";
import { errors } from "@dub/errors";
import type { RequestContext } from "@dub/http";
import { getRequestId, gatewayError, GATEWAY_TURNSTILE_FAILED } from "../context";
import { createServices } from "../services";
import { createTurnstileVerifier, type TurnstileVerifier } from "../turnstile";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^[0-9+\-()\s]{6,20}$/;
// System principal stamped on public submissions (member-service also defaults to this).
const SYSTEM_ACTOR = "system:public-participation";

function optStr(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function validate(body: unknown): { value: gateway.PublicParticipationRequest } | { errors: FieldError[] } {
  const errs: FieldError[] = [];
  const b = (body ?? {}) as Record<string, unknown>;

  // 氏名: 姓/名 の分割入力を優先し "姓 名" を合成。旧単一 `name` も後方互換で受ける。
  const lastName = optStr(b.lastName);
  const firstName = optStr(b.firstName);
  const composed = [lastName, firstName].filter((x): x is string => !!x).join(" ");
  const name = composed || (typeof b.name === "string" ? b.name.trim() : "");
  if (!name) errs.push({ field: "name", reason: "required" });

  const schoolEmail = typeof b.schoolEmail === "string" ? b.schoolEmail.trim() : "";
  if (!schoolEmail) errs.push({ field: "schoolEmail", reason: "required" });
  else if (!EMAIL_RE.test(schoolEmail)) errs.push({ field: "schoolEmail", reason: "invalid" });

  const gmail = typeof b.gmail === "string" ? b.gmail.trim() : "";
  if (!gmail) errs.push({ field: "gmail", reason: "required" });
  else if (!EMAIL_RE.test(gmail)) errs.push({ field: "gmail", reason: "invalid" });

  // 電話番号は任意。渡された時だけ緩い形式チェック。
  const phone = optStr(b.phone);
  if (phone && !PHONE_RE.test(phone)) errs.push({ field: "phone", reason: "invalid" });

  const turnstileToken = optStr(b.turnstileToken);

  if (errs.length > 0) return { errors: errs };
  return {
    value: {
      lastName,
      firstName,
      name,
      schoolEmail,
      gmail,
      nameKana: optStr(b.nameKana),
      lastNameKana: optStr(b.lastNameKana),
      firstNameKana: optStr(b.firstNameKana),
      nameRomaji: optStr(b.nameRomaji),
      lastNameRomaji: optStr(b.lastNameRomaji),
      firstNameRomaji: optStr(b.firstNameRomaji),
      phone,
      grade: optStr(b.grade),
      department: optStr(b.department),
      desiredTeamId: optStr(b.desiredTeamId),
      desiredActivity: optStr(b.desiredActivity),
      note: optStr(b.note),
      turnstileToken,
    },
  };
}

export function createPublicParticipationHandler(override?: TurnstileVerifier) {
  return async (c: Context<{ Bindings: GatewayEnv; Variables: GatewayVariables }>): Promise<Response> => {
    const requestId = getRequestId(c);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw errors.validationFailed([{ field: "body", reason: "invalid_json" }]);
    }

    const parsed = validate(raw);
    if ("errors" in parsed) throw errors.validationFailed(parsed.errors);
    const p = parsed.value;

    // Spam defense. Global rate limiting (middleware) is the always-on baseline. Turnstile
    // is layered on top but must NOT hard-fail a form that has no widget wired: verify only
    // when a verifier is injected (tests) or a secret is configured AND the client actually
    // sent a token (i.e. it rendered a widget and opted in). Absent a token, we fall through
    // to rate-limiting only — so the public 参加届 keeps working everywhere.
    const remoteIp = c.req.header("cf-connecting-ip") ?? null;
    if (override) {
      const ok = await override(p.turnstileToken ?? "", remoteIp);
      if (!ok) throw gatewayError(GATEWAY_TURNSTILE_FAILED, "Turnstile verification failed", 403);
    } else if (c.env.TURNSTILE_SECRET && p.turnstileToken) {
      const ok = await createTurnstileVerifier(c.env.TURNSTILE_SECRET)(p.turnstileToken, remoteIp);
      if (!ok) throw gatewayError(GATEWAY_TURNSTILE_FAILED, "Turnstile verification failed", 403);
    }

    // Forward to member-service internal route (genuine s2s: attaches x-dub-internal +
    // a system x-dub-user-id). This performs the same non-destructive roster reflect as
    // the authenticated path.
    const svc = createServices(c.env);
    const ctx: RequestContext = { requestId, userId: SYSTEM_ACTOR, caller: "api-gateway" };
    const submit: member.SubmitParticipationRequest = {
      lastName: p.lastName ?? null,
      firstName: p.firstName ?? null,
      name: p.name,
      schoolEmail: p.schoolEmail,
      gmail: p.gmail,
      nameKana: p.nameKana ?? null,
      lastNameKana: p.lastNameKana ?? null,
      firstNameKana: p.firstNameKana ?? null,
      nameRomaji: p.nameRomaji ?? null,
      lastNameRomaji: p.lastNameRomaji ?? null,
      firstNameRomaji: p.firstNameRomaji ?? null,
      phone: p.phone ?? null,
      grade: (p.grade as member.Grade | null) ?? null,
      department: p.department ?? null,
      desiredTeamId: p.desiredTeamId ?? null,
      desiredActivity: (p.desiredActivity as member.DesiredActivity | null) ?? null,
      note: p.note ?? null,
    };
    const res = await svc.member.post<member.SubmitParticipationResponse>(ctx, "/members/internal/participation", submit);

    const body: gateway.PublicParticipationResponse = { accepted: true, matchKind: res.matchKind };
    return c.json(body);
  };
}
