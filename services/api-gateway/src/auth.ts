// Entry authentication: token extraction (Bearer preferred -> dub_session cookie)
// and one-shot verify against auth-service. On success the gateway trusts only its
// own derived userId downstream (via x-dub-user-id).
import type { auth as authTypes } from "@dub/types";
import { errors, DubError } from "@dub/errors";
import type { RequestContext } from "@dub/http";
import type { AuthClient } from "@dub/auth-client";

export interface Authenticated {
  userId: string;
  session: authTypes.SessionInfo | null;
}

/** Extraction order is frozen: Authorization: Bearer wins, then dub_session cookie. */
export function extractToken(headers: Headers): string | null {
  const authz = headers.get("authorization");
  if (authz && authz.toLowerCase().startsWith("bearer ")) {
    const t = authz.slice(7).trim();
    if (t) return t;
  }
  const cookie = headers.get("cookie");
  if (cookie) {
    const m = /(?:^|;\s*)dub_session=([^;]+)/.exec(cookie);
    if (m && m[1]) return decodeURIComponent(m[1]);
  }
  return null;
}

/**
 * Verify at the entry. Missing/invalid token -> 401 UNAUTHENTICATED. A verify
 * transport failure (auth-service down) propagates as 502 and never reaches downstream.
 */
export async function authenticate(client: AuthClient, ctx: RequestContext, headers: Headers): Promise<Authenticated> {
  const token = extractToken(headers);
  if (!token) throw errors.unauthenticated("missing bearer/cookie token");

  let res: authTypes.AuthVerifyResponse;
  try {
    res = await client.verify(ctx, token);
  } catch (err) {
    // DubError from @dub/http (UPSTREAM_UNAVAILABLE/TIMEOUT) passes through unchanged.
    if (err instanceof DubError) throw err;
    throw errors.upstreamUnavailable("auth-service", err);
  }
  if (!res.valid || !res.userId) {
    throw errors.unauthenticated(`verify failed: ${res.reason ?? "invalid"}`);
  }
  return { userId: res.userId, session: res.session };
}
