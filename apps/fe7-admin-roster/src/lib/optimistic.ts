// Optimistic-vs-confirmed write policy (design §2-3 / frozen 1-2-6).
//   Optimistic (instant apply, rollback on error): profile edit, role grant.
//   Non-optimistic (ConfirmDialog -> await server): role revoke, permission-bundle
//   save, status change (suspend/reactivate), role create/delete, invite.
import type { identity } from "@dub/types";
import type { RoleAssignment } from "../contracts/pending";

export type RosterOperation =
  | "user.patch"
  | "role.grant"
  | "role.revoke"
  | "role.save"
  | "user.status"
  | "role.create"
  | "role.delete"
  | "user.invite";

const OPTIMISTIC_OPERATIONS: ReadonlySet<RosterOperation> = new Set<RosterOperation>([
  "user.patch",
  "role.grant",
]);

export function isOptimistic(op: RosterOperation): boolean {
  return OPTIMISTIC_OPERATIONS.has(op);
}

// ---- pure cache transforms used by onMutate / onError ----

/** Optimistically merge a profile patch into a cached user object. */
export function applyUserPatch<T extends { id: string }>(
  user: T,
  patch: Partial<T>,
): T {
  return { ...user, ...patch };
}

/** Optimistically append a pending assignment to the list. */
export function applyRoleGrant(
  assignments: readonly RoleAssignment[],
  pending: RoleAssignment,
): RoleAssignment[] {
  return [...assignments, pending];
}

/** Build the optimistic placeholder assignment shown before the server confirms. */
export function makePendingAssignment(input: {
  userId: identity.IdentityUser["id"];
  roleId: string;
  roleName: string;
  resourceType?: "event";
  resourceId?: string;
  grantedBy: string;
  now: string;
}): RoleAssignment {
  return {
    id: `optimistic:${input.roleId}:${input.resourceId ?? "org"}`,
    userId: input.userId,
    roleId: input.roleId,
    roleName: input.roleName,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    grantedBy: input.grantedBy,
    grantedAt: input.now,
  };
}
