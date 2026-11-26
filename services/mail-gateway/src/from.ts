// Outbound From resolution for the USER-FACING compose lane (POST /mail/outbox).
// A browser send must appear to come FROM the logged-in user's own company address
// (<user>@developershub.jp), not the system-default info@. The frozen SendMailRequest
// carries no `from`, so we resolve it server-side from the caller identity: look the
// user up in the roster (identity master, internal S2S GET /users/:id) and use their
// email when it is a verified @developershub.jp address. Anything else — user not in
// the roster, a non-company domain, or an identity lookup failure — safely falls back
// to the system default so a send never fails just because the From could not resolve.
import { errors } from "@dub/errors";
import { createServiceClient } from "@dub/http";
import type { RequestContext } from "@dub/http";
import type { DbClient } from "@dub/db";
import type { identity, mail } from "@dub/types";
import type { Env } from "./env";
import { DEFAULT_FROM_ADDRESS, SERVICE_NAME } from "./config";
import { findActiveSharedMailbox, memberMaySend } from "./shared-mailbox";
import { findDeliveryEnvelope, findInboundByMessageId, findSendLogById, LIST_ENVELOPE_PREFIX, wasDeliveredByList } from "./repo";

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
    // Replying to OUR OWN earlier send ("<send-log id>@domain"): keep the identity we sent
    // as, so the conversation does not switch From mid-thread (e.g. info@ -> personal).
    const localPart = bareMessageId(inReplyTo).split("@")[0] ?? "";
    if (userId && localPart.startsWith("maillog_")) {
      const ours = await findSendLogById(db, localPart);
      if (ours && ours.owner_user_id === userId && isCompanyAddress(ours.from_address)) return ours.from_address.trim();
    }
    const parent = await findInboundByMessageId(db, bareMessageId(inReplyTo));
    if (parent) {
      // The replier's OWN copy wins: a colleague who was Cc'd (or Bcc'd) replies as the
      // address it reached them at, never as the To: recipient's address.
      const own = userId ? await findDeliveryEnvelope(db, parent.id, userId) : null;
      // Reached them through a team list: answer as themselves, so the reader sees who
      // replied. The list stays on the reply through 全員に返信's Cc.
      if (own?.startsWith(LIST_ENVELOPE_PREFIX)) return await resolveUserFromAddress(env, ctx, userId);
      if (isCompanyAddress(own)) return own.trim();
      const recipients = JSON.parse(parent.to_json) as mail.MailAddress[];
      const mailbox = recipients.map((r) => r.email).find(isCompanyAddress);
      if (mailbox && !(await wasDeliveredByList(db, parent.id, mailbox))) return mailbox.trim();
    }
  } catch {
    /* fall through to the per-user resolution */
  }
  return resolveUserFromAddress(env, ctx, userId);
}

/** The From of one user-facing send, plus what the send log and the header need about it. */
export interface SendIdentity {
  fromAddress: string;
  /** Display name for the From header (a shared mailbox's), null = the bare address. */
  fromName: string | null;
  /** Shared address the send goes out as, recorded on the send log so the recipient's reply
   *  also reaches the sender. null for a person's own address or a system send. */
  sharedMailbox: string | null;
  /** The shared address the composer explicitly picked (re-checked by the scheduled drain). */
  picked: string | null;
}

/**
 * Resolve the From of a user-facing send (/outbox, /scheduled).
 *  - `fromAddress` picked: the caller's own address is always fine; a shared mailbox only when
 *    member-service says the caller may send as it; anything else is 403.
 *  - not picked: the rules above (own address / the shared mailbox a reply answers / the
 *    info@ fallback), unchanged.
 * Either way, a From that is a shared mailbox gets its display name and is recorded as one.
 */
export async function resolveSendIdentity(
  env: Env,
  ctx: RequestContext,
  db: DbClient,
  userId: string | null,
  req: { fromAddress?: string; inReplyTo?: string },
): Promise<SendIdentity> {
  const picked = req.fromAddress?.trim().toLowerCase();
  let fromAddress: string;
  let chosen: string | null = null;
  if (picked) {
    const own = await resolveUserFromAddress(env, ctx, userId);
    if (own.trim().toLowerCase() === picked) {
      fromAddress = own;
    } else {
      const shared = await findActiveSharedMailbox(db, picked);
      if (!shared || !userId) throw errors.forbidden(`not allowed to send as ${picked}`);
      let allowed: boolean;
      try {
        allowed = await memberMaySend(env.SVC_MEMBER, ctx, shared, userId);
      } catch (err) {
        throw errors.upstreamUnavailable("member-service", err);
      }
      if (!allowed) throw errors.forbidden(`not allowed to send as ${picked}`);
      fromAddress = shared.address;
      chosen = shared.address;
    }
  } else {
    fromAddress = req.inReplyTo
      ? await resolveReplyFromAddress(env, ctx, db, req.inReplyTo, userId)
      : await resolveUserFromAddress(env, ctx, userId);
  }
  const shared = await findActiveSharedMailbox(db, fromAddress);
  return {
    fromAddress,
    fromName: shared?.display_name ?? null,
    sharedMailbox: shared && userId ? shared.address : null,
    picked: chosen,
  };
}
