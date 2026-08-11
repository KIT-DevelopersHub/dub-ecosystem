// Outbound From resolution for the USER-FACING compose lane (POST /mail/outbox).
// A browser send must appear to come FROM the logged-in user's own company address
// (<user>@developershub.jp), not the system-default info@. The frozen SendMailRequest
// carries no `from`, so we resolve it server-side from the caller identity: look the
// user up in the roster (identity master, internal S2S GET /users/:id) and use their
// email when it is a verified @developershub.jp address. Anything else — user not in
// the roster, a non-company domain, or an identity lookup failure — safely falls back
// to the system default so a send never fails just because the From could not resolve.
import { createServiceClient } from "@dub/http";
import type { RequestContext } from "@dub/http";
import type { identity } from "@dub/types";
import type { Env } from "./env";
import { DEFAULT_FROM_ADDRESS, SERVICE_NAME } from "./config";

/** Verified sending domain (Resend). Only addresses on this domain may be a From. */
export const COMPANY_MAIL_DOMAIN = "developershub.jp";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The safe system-default From (info@…), used whenever a user address can't be trusted. */
export function fallbackFromAddress(env: Env): string {
  return env.MAIL_FROM_ADDRESS ?? DEFAULT_FROM_ADDRESS;
}

/** True when `email` is a well-formed address on the verified company domain. */
export function isCompanyAddress(email: string | undefined | null): email is string {
  if (!email) return false;
  const trimmed = email.trim().toLowerCase();
  return EMAIL_RE.test(trimmed) && trimmed.endsWith(`@${COMPANY_MAIL_DOMAIN}`);
}

/**
 * Resolve the From for a user-facing send: the caller's own @developershub.jp address
 * from the roster, else the info@ fallback. Never throws — an identity lookup failure
 * degrades to the fallback so the send still goes out.
 */
export async function resolveUserFromAddress(env: Env, ctx: RequestContext, userId: string | null): Promise<string> {
  const fallback = fallbackFromAddress(env);
  if (!userId) return fallback;
  try {
    const client = createServiceClient(env.SVC_IDENTITY, { service: "identity-roster", caller: SERVICE_NAME });
    const user = await client.get<identity.IdentityUser>(ctx, `/users/${encodeURIComponent(userId)}`);
    return isCompanyAddress(user?.email) ? user.email.trim() : fallback;
  } catch {
    return fallback;
  }
}
