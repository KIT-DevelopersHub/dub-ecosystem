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
// maps 1:1 to a Cloudflare Email Routing rule that forwards to the mail Worker).
// The org domain is fixed (@developershub.jp); only the local part is editable — the
// forward target is ALWAYS the mail Worker, so the UI no longer collects a destination.

export const EMAIL_ROUTING_DOMAIN = "developershub.jp" as const;

// Fixed forward target for every issued @developershub.jp address: the mail Worker
// (Cloudflare Email Routing → mail-gateway). The roster never asks the admin to choose
// a destination — inbound always routes to the mail Worker, which surfaces it in the app.
export const MAIL_WORKER_DESTINATION = "mail-gateway (Worker)" as const;

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
  /** @deprecated The forward target is fixed to the mail Worker server-side; the UI no
   *  longer collects it. Kept optional for backward compatibility with older callers. */
  destination?: string;
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

// #5: read-only diff preview of a sync (owned by identity-roster; modeled locally).
export interface EmailRoutingDiffRow {
  email: string;
  userId?: string;
  enabled?: boolean;
}
export interface EmailRoutingSyncPreview {
  toAdd: EmailRoutingDiffRow[];
  toReactivate: EmailRoutingDiffRow[];
  toRelink: EmailRoutingDiffRow[];
  toDeactivate: EmailRoutingDiffRow[];
  adminKept: EmailRoutingDiffRow[];
  projected: SyncEmailRoutingResult;
}


// ---- Offboarding (退任) one-shot (#2) ----
// The identity-LOCAL result returned by POST /identity/users/:id/offboard (owned by
// identity-roster; modeled locally until it publishes into @dub/types). The FE
// orchestrator wraps this with the cross-service steps (member在籍更新・Email Routing削除)
// into a full OffboardOutcome for partial-success display.
export type OffboardStepStatus = "done" | "skipped" | "failed";
export interface OffboardStepResult {
  step: "revoke-sessions" | "revoke-roles" | "disable-account";
  status: OffboardStepStatus;
  detail?: string;
}
export interface OffboardUserResult {
  user: identity.IdentityUser;
  revokedAssignments: number;
  alreadyDisabled: boolean;
  steps: OffboardStepResult[];
}
