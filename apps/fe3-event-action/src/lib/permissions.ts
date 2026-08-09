// Derive the event-scoped permission triplet the UI uses for show/hide/disable.
// Source = MeResponse.effectivePermissions (org-wide only in P0). Fail-closed
// while auth is unloaded (all false) — server remains the real enforcer.
import type { gateway } from "@dub/types";

export interface EventPermissions {
  read: boolean;
  write: boolean;
  admin: boolean;
}

export const DENY_ALL: EventPermissions = { read: false, write: false, admin: false };

export function derivePermissions(me: gateway.MeResponse | null, loading: boolean): EventPermissions {
  if (loading || me === null) return DENY_ALL; // fail-closed
  const p = me.permissions;
  return {
    read: p.includes("event:read"),
    write: p.includes("event:write"),
    admin: p.includes("event:admin"),
  };
}
