// POST /api/v1/public/inquiries — public receipt. Turnstile-gated, then publishes
// public.inquiry.received (the gateway's single publish exception). The gateway does
// NOT persist or notify — notification-service owns storage + dedup.
import type { Context } from "hono";
import type { GatewayEnv } from "../env";
import type { GatewayVariables } from "../context";
import type { gateway } from "@dub/types";
import type { FieldError } from "@dub/errors";
import { errors } from "@dub/errors";
import { createEvent, publishEvent } from "@dub/events";
import { getRequestId, gatewayError, GATEWAY_TURNSTILE_FAILED } from "../context";
import { createTurnstileVerifier, type TurnstileVerifier } from "../turnstile";

const KINDS: ReadonlySet<gateway.PublicInquiryKind> = new Set(["general", "sponsor", "press"]);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function validate(body: unknown): { value: gateway.PublicInquiryRequest } | { errors: FieldError[] } {
  const errs: FieldError[] = [];
  const b = (body ?? {}) as Record<string, unknown>;
  const kind = b.kind;
  if (typeof kind !== "string" || !KINDS.has(kind as gateway.PublicInquiryKind)) {
    errs.push({ field: "kind", reason: "invalid" });
  }
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) errs.push({ field: "name", reason: "required" });
  const email = typeof b.email === "string" ? b.email.trim() : "";
  if (!email) errs.push({ field: "email", reason: "required" });
  else if (!EMAIL_RE.test(email)) errs.push({ field: "email", reason: "invalid" });
  const message = typeof b.message === "string" ? b.message.trim() : "";
  if (!message) errs.push({ field: "message", reason: "required" });
  const turnstileToken = typeof b.turnstileToken === "string" ? b.turnstileToken : "";
  if (!turnstileToken) errs.push({ field: "turnstileToken", reason: "required" });

  if (errs.length > 0) return { errors: errs };
  return { value: { kind: kind as gateway.PublicInquiryKind, name, email, message, turnstileToken } };
}

export function createPublicInquiryHandler(override?: TurnstileVerifier) {
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
    const inquiry = parsed.value;

    const verify = override ?? createTurnstileVerifier(c.env.TURNSTILE_SECRET);
    const remoteIp = c.req.header("cf-connecting-ip") ?? null;
    const ok = await verify(inquiry.turnstileToken, remoteIp);
    if (!ok) throw gatewayError(GATEWAY_TURNSTILE_FAILED, "Turnstile verification failed", 403);

    const event = createEvent(
      "public.inquiry.received",
      { kind: inquiry.kind, name: inquiry.name, email: inquiry.email, message: inquiry.message },
      { requestId, actorId: null },
    );
    await publishEvent({ EVT_NOTIFICATION: c.env.EVT_NOTIFICATION }, event);

    const body: gateway.PublicInquiryResponse = { accepted: true };
    return c.json(body);
  };
}
