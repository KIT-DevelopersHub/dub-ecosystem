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
import { member, type gateway } from "@dub/types";
import type { FieldError } from "@dub/errors";
import { errors } from "@dub/errors";
import type { RequestContext } from "@dub/http";
import { getRequestId, gatewayError, GATEWAY_TURNSTILE_FAILED } from "../context";
import { createServices } from "../services";
import { createTurnstileVerifier, type TurnstileVerifier } from "../turnstile";

// System principal stamped on public submissions (member-service also defaults to this).
const SYSTEM_ACTOR = "system:public-participation";

function optStr(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function validate(body: unknown): { value: gateway.PublicParticipationRequest } | { errors: FieldError[] } {
  const b = (body ?? {}) as Record<string, unknown>;
  // 人物プロフィール項目は名簿と共通のルール (member.parsePersonProfilePatch) で検証する。
  const { value: profile, errors: bad } = member.parsePersonProfilePatch(b);
  const errs: FieldError[] = bad.map((field) => ({ field, reason: "invalid" }));

  // 氏名: 姓/名 の分割入力を優先し "姓 名" を合成。旧単一 `name` も後方互換で受ける。
  const composed = [profile.lastName, profile.firstName].filter((x): x is string => !!x).join(" ");
  const name = composed || (typeof b.name === "string" ? b.name.trim() : "");
  if (!name) errs.push({ field: "name", reason: "required" });
  // 学校メール + Gmail は参加届では必須。
  for (const k of ["schoolEmail", "gmail"] as const) {
    if (profile[k] == null && !bad.includes(k)) errs.push({ field: k, reason: "required" });
  }

  if (errs.length > 0) return { errors: errs };
  return {
    value: {
      ...profile,
      name,
      schoolEmail: profile.schoolEmail ?? "",
      gmail: profile.gmail ?? "",
      nameKana: optStr(b.nameKana),
      nameRomaji: optStr(b.nameRomaji),
      desiredTeamId: optStr(b.desiredTeamId),
      turnstileToken: optStr(b.turnstileToken),
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
    // a system x-dub-user-id). 提出は 参加届 を記録するだけで、名簿への反映は管理者が
    // 一覧で確定する（B案）。よって公開応答は accepted のみ（解決結果は返さない）。
    const svc = createServices(c.env);
    const ctx: RequestContext = { requestId, userId: SYSTEM_ACTOR, caller: "api-gateway" };
    const { turnstileToken: _token, ...submit } = p;
    await svc.member.post<member.SubmitParticipationResponse, member.SubmitParticipationRequest>(
      ctx,
      "/members/internal/participation",
      submit,
    );

    const body: gateway.PublicParticipationResponse = { accepted: true };
    return c.json(body);
  };
}
