// Name-match candidate ranking for the identity-link dialog (#1). The link is always
// human-confirmed — this only ORDERS the roster accounts so the likely match floats to
// the top; it never auto-links. Pure + unit-tested (identityMatch.test.ts).
import type { identity } from "@dub/types";

export interface RankedCandidate {
  user: identity.IdentityUser;
  /** 0 = no name signal; higher = stronger. Used only for ordering + the "候補" hint. */
  score: number;
  /** Already linked to ANOTHER member — shown but not selectable. */
  taken: boolean;
}

/** Collapse spaces/case so "山田 太郎" and "山田太郎" compare equal, and drop the email
 *  domain so "yamada@x.jp" matches a display name of "yamada". */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "").trim();
}

function nameSignals(u: identity.IdentityUser): string[] {
  const local = u.email.includes("@") ? u.email.split("@")[0]! : u.email;
  return [u.displayName, local, u.githubLogin ?? ""].map(norm).filter((s) => s.length > 0);
}

/** Score a member name against one account. Contains-match beats token-overlap. */
export function scoreMatch(memberName: string, user: identity.IdentityUser): number {
  const target = norm(memberName);
  if (target.length === 0) return 0;
  let best = 0;
  for (const sig of nameSignals(user)) {
    if (sig === target) best = Math.max(best, 100);
    else if (sig.includes(target) || target.includes(sig)) best = Math.max(best, 60);
    else if ([...sig].filter((ch) => target.includes(ch)).length >= 2) best = Math.max(best, 20);
  }
  return best;
}

/**
 * Rank all roster accounts for a member. `takenIds` are identity userIds already linked
 * to some OTHER member (from the overview) — kept in the list but flagged `taken` so the
 * UI disables them (the 1:1 link is enforced server-side too, 409).
 */
export function rankIdentityCandidates(
  memberName: string,
  users: identity.IdentityUser[],
  takenIds: ReadonlySet<string>,
): RankedCandidate[] {
  return users
    .map((user) => ({ user, score: scoreMatch(memberName, user), taken: takenIds.has(user.id) }))
    .sort((a, b) => b.score - a.score || a.user.displayName.localeCompare(b.user.displayName));
}
