// DriveShare feature api adapter. Like mail, it rides the ONE shell api-client
// (src/lib/api-client.tsx): session cookie, 401→refresh, requestId, error
// normalization. Callers never write fetch and never paste a token — the browser
// session authorizes every call, and the gateway forwards x-dub-user-id to
// drive-share-service, which authorizes drive:read / drive:write.
//
// Types are declared locally (not in @dub/types): drive:read/drive:write and the
// Drive sharing shapes are not in the frozen contract yet, exactly like the backend.
import type { ApiClient } from "../../lib/api-client.tsx";

export type ShareRole = "reader" | "commenter" | "writer" | "owner";
export type AssignableRole = "reader" | "commenter" | "writer";
export type GranteeType = "user" | "group" | "domain" | "anyone";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  ownerName: string | null;
  modifiedTime: string | null;
  webViewLink: string | null;
  linkShared: boolean;
}

export interface SharePermission {
  id: string;
  type: GranteeType;
  role: ShareRole;
  emailAddress: string | null;
  displayName: string | null;
  domain: string | null;
  /** True when the grant is inherited from an ancestor folder (or shared drive): Drive
   *  refuses to change/remove it on this item (403 cannotDeletePermission), so the UI
   *  shows it read-only with a reason instead of an actionable revoke/role control. */
  inherited: boolean;
}

export interface ListFilesResult {
  files: DriveFile[];
  nextCursor: string | null;
}

export interface ListPermissionsResult {
  fileId: string;
  permissions: SharePermission[];
}

export interface ListFilesQuery {
  q?: string;
  folderId?: string;
  cursor?: string;
  limit?: number;
}

// ---- Role-based grants (identity roles + driveshare role-grants) ----
// A driveRole is the Drive capability granted to a whole role; it reuses the same
// reader/commenter/writer scale as an individual grant (AssignableRole).
export type DriveRole = AssignableRole;

/** An org role, sourced from identity via the gateway (GET /identity/roles). */
export interface IdentityRole {
  id: string;
  orgId: string;
  name: string;
  permissions: string[];
  isSystem: boolean;
}

export interface ListRolesResult {
  items: IdentityRole[];
  nextCursor: string | null;
}

/** A role member the fan-out could not apply (invalid email / Drive refused). */
export interface SkippedMember {
  email: string;
  reason: string;
}

/** A role member shared only via an invite because the address has no Google account
 *  (e.g. a Cloudflare Email-Routing alias). The permission is pending until that address
 *  is backed by a Google account. */
export interface InvitedMember {
  email: string;
}

/** One role→file Drive grant; memberCount = members the role expands to. `skipped`
 *  (only on the apply/reapply response) lists members Drive refused, with a reason. */
export interface RoleFileGrant {
  id: string;
  fileId: string;
  roleId: string;
  roleName: string;
  driveRole: DriveRole;
  memberCount: number;
  appliedCount: number;
  grantedBy: string;
  grantedAt: string;
  skipped?: SkippedMember[];
  invited?: InvitedMember[];
}

export interface ListRoleGrantsResult {
  items: RoleFileGrant[];
}

export interface DriveShareApi {
  /** List files/folders in the Hackit shared Drive (drive:read). */
  listFiles(query?: ListFilesQuery): Promise<ListFilesResult>;
  /** List one file's sharing entries (drive:read). */
  listPermissions(fileId: string): Promise<ListPermissionsResult>;
  /** Grant a role to an email (drive:write). */
  grant(fileId: string, req: { emailAddress: string; role: AssignableRole }): Promise<{ permission: SharePermission }>;
  /** Change an existing permission's role (drive:write). */
  updateRole(fileId: string, permissionId: string, role: AssignableRole): Promise<{ permission: SharePermission }>;
  /** Revoke a permission (drive:write). */
  revoke(fileId: string, permissionId: string): Promise<{ revoked: boolean }>;
  /** Turn link (anyone-with-the-link) sharing on/off (drive:write). */
  setLinkSharing(fileId: string, req: { enabled: boolean; role?: AssignableRole }): Promise<ListPermissionsResult>;
  /** List the org's roles (identity, via gateway) — the pickable roles to grant. */
  listRoles(): Promise<ListRolesResult>;
  /** Every role→file grant in the org (for the per-file list chips). */
  listAllRoleGrants(): Promise<ListRoleGrantsResult>;
  /** One file's role grants (for the panel). */
  listRoleGrants(fileId: string): Promise<ListRoleGrantsResult>;
  /** Grant a Drive role to a whole org role (drive:write). */
  grantRole(fileId: string, req: { roleId: string; driveRole: DriveRole }): Promise<RoleFileGrant>;
  /** Revoke a role grant from a file (drive:write). */
  revokeRoleGrant(fileId: string, roleId: string): Promise<void>;
  /** Re-apply a role grant so every current member is (re)synced (drive:write). */
  reapplyRoleGrant(fileId: string, roleId: string): Promise<RoleFileGrant>;
}

const IDENTITY_BASE = "/api/v1/identity";

const BASE = "/api/v1/driveshare";

export function createDriveShareApi(api: ApiClient): DriveShareApi {
  return {
    listFiles: (query) => {
      const q: Record<string, string | number | boolean | undefined> = {};
      if (query?.q !== undefined) q.q = query.q;
      if (query?.folderId !== undefined) q.folderId = query.folderId;
      if (query?.cursor !== undefined) q.cursor = query.cursor;
      if (query?.limit !== undefined) q.limit = query.limit;
      const hasQuery = Object.keys(q).length > 0;
      return api.request<ListFilesResult>({ method: "GET", path: `${BASE}/files`, ...(hasQuery ? { query: q } : {}) });
    },
    listPermissions: (fileId) =>
      api.request<ListPermissionsResult>({
        method: "GET",
        path: `${BASE}/files/${encodeURIComponent(fileId)}/permissions`,
      }),
    grant: (fileId, req) =>
      api.request<{ permission: SharePermission }>({
        method: "POST",
        path: `${BASE}/files/${encodeURIComponent(fileId)}/permissions`,
        body: req,
      }),
    updateRole: (fileId, permissionId, role) =>
      api.request<{ permission: SharePermission }>({
        method: "PATCH",
        path: `${BASE}/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}`,
        body: { role },
      }),
    revoke: (fileId, permissionId) =>
      api.request<{ revoked: boolean }>({
        method: "DELETE",
        path: `${BASE}/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}`,
      }),
    setLinkSharing: (fileId, req) =>
      api.request<ListPermissionsResult>({
        method: "PUT",
        path: `${BASE}/files/${encodeURIComponent(fileId)}/link`,
        body: req,
      }),
    listRoles: () => api.request<ListRolesResult>({ method: "GET", path: `${IDENTITY_BASE}/roles` }),
    listAllRoleGrants: () => api.request<ListRoleGrantsResult>({ method: "GET", path: `${BASE}/role-grants` }),
    listRoleGrants: (fileId) =>
      api.request<ListRoleGrantsResult>({
        method: "GET",
        path: `${BASE}/files/${encodeURIComponent(fileId)}/role-grants`,
      }),
    grantRole: (fileId, req) =>
      api.request<RoleFileGrant>({
        method: "POST",
        path: `${BASE}/files/${encodeURIComponent(fileId)}/role-grants`,
        body: req,
      }),
    revokeRoleGrant: (fileId, roleId) =>
      api.request<void>({
        method: "DELETE",
        path: `${BASE}/files/${encodeURIComponent(fileId)}/role-grants/${encodeURIComponent(roleId)}`,
      }),
    reapplyRoleGrant: (fileId, roleId) =>
      api.request<RoleFileGrant>({
        method: "POST",
        path: `${BASE}/files/${encodeURIComponent(fileId)}/role-grants/${encodeURIComponent(roleId)}/reapply`,
      }),
  };
}

// ---- pure helpers (unit-tested) ----

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

/** Japanese label for a Drive role, used across the UI. */
export function roleLabel(role: ShareRole): string {
  switch (role) {
    case "owner":
      return "オーナー";
    case "writer":
      return "編集者";
    case "commenter":
      return "コメント可";
    case "reader":
      return "閲覧者";
  }
}

/** Short driveRole label for role chips/panels: reader→閲覧, commenter→コメント, writer→編集. */
export function driveRoleLabel(driveRole: DriveRole): string {
  switch (driveRole) {
    case "writer":
      return "編集";
    case "commenter":
      return "コメント";
    case "reader":
      return "閲覧";
  }
}

/** Chip text for a role grant, e.g. "開発: 編集". Never color-only — the label carries the meaning. */
export function roleGrantChipLabel(grant: Pick<RoleFileGrant, "roleName" | "driveRole">): string {
  return `${grant.roleName}: ${driveRoleLabel(grant.driveRole)}`;
}

/**
 * Badge tone per driveRole (must stay accessible: paired with the text label).
 * writer = emphasis (brand), commenter = info, reader = subtle (neutral).
 */
export function driveRoleTone(driveRole: DriveRole): "brand" | "info" | "neutral" {
  switch (driveRole) {
    case "writer":
      return "brand";
    case "commenter":
      return "info";
    case "reader":
      return "neutral";
  }
}
