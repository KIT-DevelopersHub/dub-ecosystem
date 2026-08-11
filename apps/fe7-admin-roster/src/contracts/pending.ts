// Local, PENDING identity contract shapes referenced by the FE7 design (§2-4/§2-5)
// but not yet present in the frozen `@dub/types` identity namespace at this cut:
//   CreateRoleRequest, UpdateRoleRequest, AssignRoleRequest, RoleAssignment.
//
// Cross-PR contract source: these are OWNED by services/identity-roster, which is
// on a separate, still-unmerged branch and is OFF-LIMITS to this PR. FE7 therefore
// models them LOCALLY here (do NOT import from services/identity-roster, and do not
// take a build dependency on it). When identity-roster merges and publishes these
// into the `@dub/types` identity namespace, delete this file and import from there.
//
// Kept minimal and P0-scoped (resourceType "event" only; task-scope is P1 per
// design #5).
import type { identity, common } from "@dub/types";

export interface CreateRoleRequest {
  name: string;
  permissions: identity.PermissionKey[];
}

// PATCH sends only the changed fields (design §2-4 "差分のみ").
export interface UpdateRoleRequest {
  name?: string;
  permissions?: identity.PermissionKey[];
}

// P0: org-wide (no resource fields) or event-scoped. Fields are OMITTED, not null,
// for org-wide (design test "ScopePicker": undefined, not null).
export interface AssignRoleRequest {
  roleId: common.RoleId;
  resourceType?: "event";
  resourceId?: common.EventId;
}

export interface RoleAssignment {
  id: string; // assignment id
  userId: common.UserId;
  roleId: common.RoleId;
  roleName: string;
  resourceType: "event" | null; // null = org-wide
  resourceId: string | null;
  grantedBy: common.UserId;
  grantedAt: common.ISODateTime;
}

// ---- Email Routing (Cloudflare Email Routing @developershub.jp) ----
// PENDING contract, OWNED by the Email Routing proxy service (separate agent /
// unmerged branch). Modeled locally here until it publishes into @dub/types.
// Gateway boundary: `/api/v1/mail/admin/email-routing/addresses` (each managed address
// maps 1:1 to a Cloudflare Email Routing rule that forwards to `destination`).
// The org domain is fixed (@developershub.jp); only the local part is editable.

export const EMAIL_ROUTING_DOMAIN = "developershub.jp" as const;

export interface EmailRoutingAddress {
  id: string; // rule id
  localPart: string; // e.g. "info" — address is `${localPart}@developershub.jp`
  address: string; // full address, server-derived
  destination: string; // forward-to address (the Email Routing rule action)
  enabled: boolean; // rule enabled/paused
  createdAt: common.ISODateTime;
}

export interface CreateEmailAddressRequest {
  localPart: string;
  destination: string;
}

// ---- Roster provenance + Email Routing sync (identity-roster) ----
// identity-roster tags each roster row with its provenance and exposes a sync
// endpoint that upserts the @developershub.jp Email Routing addresses by email.
// Modeled locally until identity-roster publishes it into @dub/types.
export type UserSource = "manual" | "email-routing";

// The frozen identity.IdentityUser plus the provenance field the roster surfaces.
// `source` is optional so this stays mutually assignable with identity.IdentityUser.
export type RosterUser = identity.IdentityUser & { source?: UserSource };

// One @developershub.jp address relayed to the sync endpoint (read from the proxy).
export interface SyncEmailRoutingAddress {
  address: string;
  destination?: string | null;
  enabled?: boolean;
}

export interface SyncEmailRoutingResult {
  added: number;
  updated: number;
  deactivated: number;
  total: number;
}

// PATCH sends only the changed fields (enable/disable toggle, or new destination).
export interface UpdateEmailAddressRequest {
  enabled?: boolean;
  destination?: string;
}
