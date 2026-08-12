// Inbound owner resolution (per-account Inbox scope). An inbound message is delivered
// to one or more recipient addresses; the owner is the roster user whose email matches a
// recipient. We resolve it via identity-roster's internal lookup (POST /internal/users/
// lookup { email } -> { user }). Generic + best-effort: the FIRST recipient that maps to
// an active roster user wins; if none match (shared mailbox, non-roster address, or an
// identity failure) the owner is null and the message stays invisible to every account
// (fail-closed) until an owner can be assigned. Never throws — ingest must not fail just
// because owner resolution could not complete.
import { createServiceClient } from "@dub/http";
import type { RequestContext } from "@dub/http";
import type { identity, mail } from "@dub/types";
import type { Fetcher } from "@cloudflare/workers-types";
import { SERVICE_NAME } from "./config";

// Cap the number of identity lookups per inbound message (most mail has 1–2 recipients;
// this bounds a pathological To: header with hundreds of addresses).
const MAX_LOOKUPS = 5;

/**
 * Resolve the owning roster userId for an inbound message from its recipient addresses.
 * Returns the userId of the first recipient that maps to a roster user, else null.
 */
export async function resolveInboundOwner(
  identityBinding: Fetcher | undefined,
  ctx: RequestContext,
  recipients: readonly mail.MailAddress[],
): Promise<string | null> {
  if (!identityBinding) return null;
  const client = createServiceClient(identityBinding, { service: "identity-roster", caller: SERVICE_NAME });

  const seen = new Set<string>();
  let looked = 0;
  for (const r of recipients) {
    const email = r.email?.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    if (looked >= MAX_LOOKUPS) break;
    looked++;
    try {
      const res = await client.post<{ user: identity.IdentityUser | null }, { email: string }>(
        ctx,
        "/internal/users/lookup",
        { email },
      );
      if (res?.user?.id) return res.user.id;
    } catch {
      // identity failure for this address — try the next recipient, else fall through null.
    }
  }
  return null;
}
