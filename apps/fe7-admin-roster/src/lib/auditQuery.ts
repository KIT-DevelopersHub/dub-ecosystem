// Build the identity-scoped audit query for the change-history screen.
// FE7 only ever shows identity.* actions (design §1: not the generic audit viewer).
import type { auditLog } from "@dub/types";

// Actions FE7 surfaces (design §5 audit dependency).
export const IDENTITY_AUDIT_ACTION_PREFIX = "identity." as const;

export interface AuditFilters {
  actorId: string | null;
  action: string | null; // a specific identity.* action, or null = all identity.*
  since: string | null; // ISO date
  until: string | null;
  cursor?: string;
  limit?: number;
}

export const DEFAULT_AUDIT_FILTERS: AuditFilters = {
  actorId: null,
  action: null,
  since: null,
  until: null,
};

/** Map UI filters to the frozen auditLog.AuditLogQuery, scoped to identity.*. */
export function buildAuditQuery(filters: AuditFilters): auditLog.AuditLogQuery {
  const q: auditLog.AuditLogQuery = {
    // Default: all identity actions. A specific action narrows within the prefix.
    action: filters.action ?? IDENTITY_AUDIT_ACTION_PREFIX,
  };
  if (filters.actorId) q.actorId = filters.actorId;
  if (filters.since) q.since = filters.since;
  if (filters.until) q.until = filters.until;
  if (filters.cursor) q.cursor = filters.cursor;
  if (typeof filters.limit === "number") q.limit = filters.limit;
  return q;
}

/** Guard: is this record one FE7 is allowed to render (identity.* only)? */
export function isIdentityAuditAction(action: string): boolean {
  return action.startsWith(IDENTITY_AUDIT_ACTION_PREFIX);
}
