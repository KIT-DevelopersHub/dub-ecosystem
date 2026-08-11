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
import type { DbClient } from "@dub/db";
import type { identity, mail } from "@dub/types";
import type { Env } from "./env";
import { DEFAULT_FROM_ADDRESS, SERVICE_NAME } from "./config";
import { findInboundByMessageId } from "./repo";

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

/** Angle-bracket-strip a Message-Id ("<x@y>" -> "x@y") so it matches the stored value. */
function bareMessageId(id: string): string {
  return id.trim().replace(/^<|>$/g, "").trim();
}

/**
 * Resolve the From for a REPLY. A reply to a received message goes out AS the shared
 * mailbox the original was addressed to (e.g. info@developershub.jp) rather than the
 * individual reader's personal address. Two reasons: (1) the external correspondent
 * emailed info@ and should see a reply from info@, and (2) their reply then returns to
 * info@ — the address wired to this Worker via Email Routing — so the loop closes (a
 * reply sent from an unrouted personal/admin address would bounce back to that address,
 * never reaching Dub). Falls back to the per-user resolution when the parent isn't a
 * known inbound message (e.g. replying to our own sent mail) so nothing regresses.
 */
export async function resolveReplyFromAddress(
  env: Env,
  ctx: RequestContext,
  db: DbClient,
  inReplyTo: string,
  userId: string | null,
): Promise<string> {
  try {
    const parent = await findInboundByMessageId(db, bareMessageId(inReplyTo));
    if (parent) {
      const recipients = JSON.parse(parent.to_json) as mail.MailAddress[];
      const mailbox = recipients.map((r) => r.email).find(isCompanyAddress);
      if (mailbox) return mailbox.trim();
    }
  } catch {
    /* fall through to the per-user resolution */
  }
  return resolveUserFromAddress(env, ctx, userId);
}
