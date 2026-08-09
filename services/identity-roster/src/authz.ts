// RBAC evaluation — the frozen semantics (identity-roster.md §2-2). Pure over the
// data the repo already loaded, so the same code path serves POST /authz/check,
// the /me effective-permissions aggregation and the service's own dogfood guards.
import type { identity } from "@dub/types";
import type { AssignmentRow, RoleRow, UserRow } from "./repo/types";
import { isPermissionKey } from "./permissions";

export interface EvalContext {
  user: UserRow | null;
  orgId: string;
  // role lookup for the roles referenced by the user's assignments
  roleById: Map<string, RoleRow>;
  assignments: AssignmentRow[];
}

/**
 * Decide a single check. Default deny. Preconditions: user active AND a member of
 * req.orgId. Allow if any assignment (a) is in req.orgId, (b) whose role grants the
 * permission, and (c) is org-wide OR matches the query's resourceType+resourceId.
 * Non-catalog permission keys are always denied.
 */
export function evaluate(ctx: EvalContext, q: identity.AuthzQuery): boolean {
  const { user, orgId } = ctx;
  if (!user || user.status !== "active" || user.orgId !== orgId) return false;
  if (!isPermissionKey(q.permission)) return false;

  const resourceType = q.resourceType ?? null;
  const resourceId = q.resourceId ?? null;

  for (const a of ctx.assignments) {
    if (a.orgId !== orgId) continue;
    const role = ctx.roleById.get(a.roleId);
    if (!role || !role.permissions.includes(q.permission)) continue;
    const orgWide = a.resourceType === null && a.resourceId === null;
    if (orgWide) return true;
    if (a.resourceType === resourceType && a.resourceId === resourceId) return true;
  }
  return false;
}

/** Org-wide effective permission set (used by /me aggregation; resource-scoped grants stay server-side). */
export function effectiveOrgWidePermissions(ctx: EvalContext): identity.PermissionKey[] {
  const { user, orgId } = ctx;
  if (!user || user.status !== "active" || user.orgId !== orgId) return [];
  const set = new Set<identity.PermissionKey>();
  for (const a of ctx.assignments) {
    if (a.orgId !== orgId) continue;
    if (a.resourceType !== null || a.resourceId !== null) continue; // org-wide only
    const role = ctx.roleById.get(a.roleId);
    if (!role) continue;
    for (const p of role.permissions) set.add(p);
  }
  return [...set];
}
