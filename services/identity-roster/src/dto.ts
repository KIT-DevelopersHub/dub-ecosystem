// Service-internal request/response shapes NOT carried by the frozen @dub/types
// identity namespace (management endpoints + provision response). Public read
// models (IdentityUser, Role, AuthzCheckResponse, ...) always come from @dub/types.
import type { common, identity } from "@dub/types";
import type { UserSource } from "./repo/types";

// The frozen identity.IdentityUser stays frozen (P0 contract); provenance is exposed
// as a superset field the roster console reads (same pattern as RoleWithMemberCount).
// A view carrying source is assignable wherever identity.IdentityUser is expected.
export type IdentityUserView = identity.IdentityUser & { source: UserSource };
export type IdentityUserDetailView = identity.IdentityUserDetail & { source: UserSource };

// ---- Email Routing sync (roster from Cloudflare Email Routing) ----
// The FE relays the @developershub.jp addresses read from the mail-gateway proxy
// (it holds mail:admin) to this synchronous endpoint, which upserts them by email.
export interface EmailRoutingAddressInput {
  address: string; // full @developershub.jp address == the user email
  destination?: string | null; // forward target (informational; not stored yet)
  enabled?: boolean; // disabled rules are still listed but land as status='disabled'
}
export interface SyncEmailRoutingRequest {
  addresses: EmailRoutingAddressInput[];
}
export interface SyncEmailRoutingResult {
  added: number; // new roster rows created
  updated: number; // existing rows marked source=email-routing (or reactivated)
  deactivated: number; // previously-synced rows no longer present -> status=disabled
  total: number; // addresses accepted from the request
}

// ---- Email Routing sync PREVIEW (#5): read-only diff before applying ----
// Same reconciliation as syncEmailRouting, but computes the plan WITHOUT writing so the
// console can show what would change and require an explicit apply. `projected` equals the
// SyncEmailRoutingResult the subsequent apply is expected to return.
export interface EmailRoutingDiffRow {
  email: string;
  userId?: string; // present for rows that already exist on the roster
  enabled?: boolean; // present for incoming addresses (add/reactivate)
}
export interface EmailRoutingSyncPreview {
  toAdd: EmailRoutingDiffRow[]; // in Email Routing, not yet on the roster -> new row
  toReactivate: EmailRoutingDiffRow[]; // disabled email-routing rows re-appearing enabled
  toRelink: EmailRoutingDiffRow[]; // existing manual rows whose provenance would flip to email-routing
  toDeactivate: EmailRoutingDiffRow[]; // owned rows no longer present -> would be disabled
  adminKept: EmailRoutingDiffRow[]; // owned rows that WOULD deactivate but are admins (kept, guarded)
  projected: SyncEmailRoutingResult; // the counts the apply is expected to produce
}

export interface UpdateUserRequest {
  displayName?: string;
  githubLogin?: string | null;
  status?: identity.UserStatus; // "disabled"/"rejected" => sync session revoke
}

// ---- Offboarding (退任): one-shot within identity ----
// Composes the identity-LOCAL退任 steps atomically + idempotently: revoke live
// sessions (fail-close), strip every role assignment, then disable the account. The
// cross-service steps (Email Routing削除・member在籍更新) are chained by the caller
// (fe7) around this and reported alongside these results for partial-success visibility.
export type OffboardStepStatus = "done" | "skipped" | "failed";
export interface OffboardStepResult {
  step: "revoke-sessions" | "revoke-roles" | "disable-account";
  status: OffboardStepStatus;
  detail?: string; // e.g. count for revoke-roles, or an error reason for failed
}
export interface OffboardUserResult {
  user: identity.IdentityUser; // status now "disabled"
  revokedAssignments: number; // roles stripped this call (0 when idempotent re-run)
  alreadyDisabled: boolean; // true when the account was already disabled on entry
  steps: OffboardStepResult[];
}

export interface CreateRoleRequest {
  name: string;
  permissions: identity.PermissionKey[];
}
export interface UpdateRoleRequest {
  name?: string;
  permissions?: identity.PermissionKey[];
}
export interface AssignRoleRequest {
  roleId: common.RoleId;
  resourceType?: string; // P0: "event"
  resourceId?: string;
}

// Role viewed WITH its live member count (org-scoped, distinct users holding the
// role at any scope). Superset of the frozen identity.Role — FE7's RoleListPage
// types identity.Role and ignores the extra field; the RBAC admin console reads
// memberCount. Added here (not in @dub/types) so the frozen contract stays frozen.
export type RoleWithMemberCount = identity.Role & { memberCount: number };

// Assignment as the FE renders it (fe7 contracts/pending RoleAssignment): the raw
// AssignmentRow plus the denormalized roleName. This is the wire shape returned by
// POST /users/:id/roles and GET /users/:id/roles so the front-end never has to
// re-join role names client-side.
export interface RoleAssignmentView {
  id: string; // assignment id
  userId: common.UserId;
  roleId: common.RoleId;
  roleName: string;
  resourceType: string | null; // null = org-wide
  resourceId: string | null;
  grantedBy: common.UserId;
  grantedAt: common.ISODateTime;
}

export interface InviteUserResponse {
  user: identity.IdentityUser; // status = "invited"
}

export type ProvisionStatus = "existing" | "provisioned" | "rejected";
export interface ProvisionUserResponse {
  status: ProvisionStatus; // rejected = not on the invite roster (auth maps to 403)
  user: identity.IdentityUser | null; // null when rejected (no row created)
}


export interface EffectivePermissionsResponse {
  userId: common.UserId;
  orgId: common.OrgId;
  permissions: identity.PermissionKey[]; // org-wide only
}
