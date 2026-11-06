// Drift between what the role grants say a file's sharing SHOULD be and what Drive
// actually has. Pure (no I/O) so every rule is unit-tested without Drive or identity.
//
// Expected = for every role grant on the file, each active member's email at the grant's
// driveRole (several grants on one email -> the strongest wins, which is what the fan-out
// would leave in place). Actual = the file's Drive permissions.
//
// Rules:
//   • owner permissions are the account Drive is accessed as — never drift;
//   • an INHERITED permission is decided by the ancestor folder, not this item, so it is
//     never reported as unexpected / stronger-than-the-role here (it still counts as access
//     for the "missing" check — the member can open the file);
//   • a file with no role grant expects nobody, so every direct share on it is unexpected —
//     that is exactly what is left behind after the last role is removed.
import type {
  AssignableDriveRole,
  FileShareDrift,
  SharePermission,
  ShareDriftItem,
  ShareRole,
} from "./types";

const RANK: Record<ShareRole, number> = { reader: 1, commenter: 2, writer: 3, owner: 4 };

export interface ExpectedGrant {
  roleName: string;
  driveRole: AssignableDriveRole;
  /** Active member emails (trimmed, lowercased). */
  emails: readonly string[];
}

interface ExpectedAccess {
  driveRole: AssignableDriveRole;
  roleNames: string[];
}

export function computeShareDrift(
  fileId: string,
  grants: readonly ExpectedGrant[],
  permissions: readonly SharePermission[],
): FileShareDrift {
  const expected = new Map<string, ExpectedAccess>();
  for (const g of grants) {
    for (const email of g.emails) {
      const cur = expected.get(email);
      if (!cur) expected.set(email, { driveRole: g.driveRole, roleNames: [g.roleName] });
      else {
        cur.roleNames.push(g.roleName);
        if (RANK[g.driveRole] > RANK[cur.driveRole]) cur.driveRole = g.driveRole;
      }
    }
  }

  const items: ShareDriftItem[] = [];
  const seen = new Set<string>();
  let matchedCount = 0;

  for (const p of permissions) {
    if (p.role === "owner") continue;
    const email = p.type === "user" && p.emailAddress ? p.emailAddress.trim().toLowerCase() : null;
    const exp = email ? expected.get(email) : undefined;
    if (email && exp) seen.add(email);
    // Inherited extra / stronger access belongs to the parent's drift; weaker access is
    // still a real shortfall on this item, so it falls through.
    if (p.inherited && (!exp || RANK[p.role] >= RANK[exp.driveRole])) {
      if (exp) matchedCount++;
      continue;
    }
    const grantee = {
      permissionId: p.id,
      granteeType: p.type,
      email: p.emailAddress,
      displayName: p.displayName,
      domain: p.domain,
      actualRole: p.role,
    };
    if (!exp) {
      items.push({ kind: "unexpected", ...grantee, expectedRole: null, roleNames: [] });
    } else if (RANK[p.role] > RANK[exp.driveRole]) {
      items.push({ kind: "excess_role", ...grantee, expectedRole: exp.driveRole, roleNames: exp.roleNames });
    } else if (RANK[p.role] < RANK[exp.driveRole]) {
      items.push({ kind: "insufficient_role", ...grantee, expectedRole: exp.driveRole, roleNames: exp.roleNames });
    } else {
      matchedCount++;
    }
  }

  for (const [email, exp] of expected) {
    if (seen.has(email)) continue;
    items.push({
      kind: "missing",
      permissionId: null,
      granteeType: "user",
      email,
      displayName: null,
      domain: null,
      actualRole: null,
      expectedRole: exp.driveRole,
      roleNames: exp.roleNames,
    });
  }

  return { fileId, grantCount: grants.length, expectedCount: expected.size, matchedCount, items };
}
