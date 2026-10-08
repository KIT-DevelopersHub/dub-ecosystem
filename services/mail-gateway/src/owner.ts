// Inbound owner resolution (per-account Inbox scope). The owner is the roster user whose
// email matches one of the message's delivery addresses. We resolve it via identity-
// roster's internal lookup (POST /internal/users/lookup { email } -> { user }).
//
// Resolution order — the candidate list is built by parseInbound (see OwnerAddressPolicy):
//   1. the ENVELOPE recipient — the address Email Routing actually delivered this copy
//      to. Authoritative: it is the real delivery target, not attacker-supplied text.
//   2. the To: HEADER addresses, in order — a hint only. A message where we sit in CC/BCC
//      carries an EXTERNAL To:, so a To:-only resolution left it ownerless (the bug this
//      ordering fixes). Kept as a fallback, since the envelope address of a catch-all /
//      +suffix delivery need not match a roster email verbatim.
//   3. the envelope recipient when it is the SHARED system address (info@) — last, so a
//      message addressed to an individual is not re-homed to the shared account.
//   The compliance ARCHIVE address (archive@) is never a candidate at all: every outbound
//   send is auto-CC'd there, and those copies are mail:read_all oversight material.
//
// Generic + best-effort: the FIRST candidate that maps to a roster user wins; if none
// match (shared mailbox, non-roster address, or an identity failure) the owner is null and
// the message stays invisible to every account (fail-closed) until an owner can be
// assigned. Never throws — ingest must not fail just because owner resolution could not
// complete. NOTE: /internal/users/lookup returns a user of ANY status (it does not filter
// status === "active"), so a disabled roster address can still own a message; tightening
// that changes existing visibility and is deliberately out of this fix's scope.
import { createServiceClient } from "@dub/http";
import type { RequestContext } from "@dub/http";
import type { identity, mail } from "@dub/types";
import type { Fetcher } from "@cloudflare/workers-types";
import { SERVICE_NAME } from "./config";

// Cap the number of identity lookups per inbound message (most mail has 1–2 recipients;
// this bounds a pathological To: header with hundreds of addresses). 6 = the envelope
// recipient + the original 5-address To: budget, so adding the envelope candidate did not
// shrink the header budget and push a legitimate trailing recipient out of range.
const MAX_LOOKUPS = 6;

/**
 * Resolve the owning roster userId for an inbound message from its delivery addresses.
 * `candidates` must be ordered most-authoritative-first (envelope recipient, then To:).
 * Returns the userId of the first candidate that maps to a roster user, else null.
 */
export async function resolveInboundOwner(
  identityBinding: Fetcher | undefined,
  ctx: RequestContext,
  candidates: readonly mail.MailAddress[],
): Promise<string | null> {
  if (!identityBinding) return null;
  const client = createServiceClient(identityBinding, { service: "identity-roster", caller: SERVICE_NAME });

  const seen = new Set<string>();
  let looked = 0;
  for (const r of candidates) {
    const email = r.email?.trim().toLowerCase();
    // `seen` is checked BEFORE the cap so a duplicate (envelope address repeated in To:)
    // never consumes a lookup slot.
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
