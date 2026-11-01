// POST /api/v1/public/webhooks/resend — Resend delivery-event webhook (bounce / suppressed /
// complained / failed / delayed). Public because Resend holds no session; mail-gateway has
// no public hostname, so the gateway is the only door.
//
// Pure transport: the body is forwarded BYTE-FOR-BYTE with only the svix-* headers to
// mail-gateway's INTERNAL /internal/webhooks/resend, which verifies the Svix HMAC over those
// exact bytes (re-serializing here would break the signature). Status is passed through so
// Resend retries on 5xx and stops on 2xx/4xx.
import type { Context } from "hono";
import { errors } from "@dub/errors";
import { HDR_CALLER, HDR_INTERNAL, HDR_REQUEST_ID, INTERNAL_HEADER_VALUE } from "@dub/observability";
import type { GatewayEnv } from "../env";
import type { GatewayVariables } from "../context";
import { getRequestId } from "../context";

const MAX_BODY_BYTES = 256 * 1024;
const FORWARDED = ["svix-id", "svix-timestamp", "svix-signature", "content-type"] as const;

export async function publicResendWebhookHandler(
  c: Context<{ Bindings: GatewayEnv; Variables: GatewayVariables }>,
): Promise<Response> {
  if (Number(c.req.header("content-length") ?? 0) > MAX_BODY_BYTES) {
    throw errors.validationFailed([{ field: "body", reason: "too_large" }]);
  }
  const body = await c.req.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) throw errors.validationFailed([{ field: "body", reason: "too_large" }]);

  const headers = new Headers({
    [HDR_INTERNAL]: INTERNAL_HEADER_VALUE,
    [HDR_REQUEST_ID]: getRequestId(c),
    [HDR_CALLER]: "api-gateway",
  });
  for (const name of FORWARDED) {
    const v = c.req.header(name);
    if (v) headers.set(name, v);
  }
  const res = await c.env.SVC_MAIL_GATEWAY.fetch(
    new Request("https://mail-gateway/internal/webhooks/resend", { method: "POST", headers, body }),
  );
  return new Response(await res.arrayBuffer(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
