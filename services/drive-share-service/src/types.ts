// Domain contract for the Hackit Drive sharing manager. These are the wire shapes
// the SPA (fe2 driveshare feature) consumes; they are a stable projection of Google
// Drive v3 resources (files + permissions) so the frontend never sees a raw Google
// payload and a future auth/account swap changes nothing here.

/** A Drive file or folder as shown in the sharing manager list. */
export interface DriveFile {
  id: string;
  name: string;
  /** Drive mimeType (e.g. application/vnd.google-apps.folder for folders). */
  mimeType: string;
  /** True when mimeType is the Drive folder type — the SPA renders a folder glyph. */
  isFolder: boolean;
  /** Owner display name (best-effort; personal Drive always owned by hackit@). */
  ownerName: string | null;
  modifiedTime: string | null;
  webViewLink: string | null;
  /** Whether any "anyone" (link) permission currently exists on the file. */
  linkShared: boolean;
}

export interface ListFilesResult {
  files: DriveFile[];
  /** Opaque Drive pageToken to fetch the next page, or null when exhausted. */
  nextCursor: string | null;
}

/** Roles the manager can assign. `owner` is shown (read-only) but never assigned
 *  here — ownership transfer is a deliberate, separate operation we do not expose. */
export type ShareRole = "reader" | "commenter" | "writer" | "owner";

/** Grantee kinds Drive supports. The manager grants `user` and toggles `anyone`
 *  (link sharing); `group`/`domain` are surfaced read-only if already present. */
export type GranteeType = "user" | "group" | "domain" | "anyone";

/** One sharing entry on a file (Drive permission resource projection). */
export interface SharePermission {
  id: string;
  type: GranteeType;
  role: ShareRole;
  /** Present for user/group grantees; absent for `anyone` (link) and `domain`. */
  emailAddress: string | null;
  displayName: string | null;
  /** Present for `domain` grantees. */
  domain: string | null;
  /** True when this permission is inherited from an ancestor folder (or shared drive)
   *  and therefore CANNOT be changed or removed on this item directly — Google returns
   *  403 `cannotDeletePermission` for such a delete. Derived from Drive
   *  `permissionDetails[].inherited` (every detail entry inherited). The manager
   *  disables the role change / revoke for these rows and explains why. */
  inherited: boolean;
}

export interface ListPermissionsResult {
  fileId: string;
  permissions: SharePermission[];
}

export interface GrantPermissionRequest {
  emailAddress: string;
  role: Exclude<ShareRole, "owner">;
}

export interface UpdatePermissionRequest {
  role: Exclude<ShareRole, "owner">;
}

/** Link-sharing toggle. `on` creates an `anyone` permission at `role`; `off`
 *  removes the existing `anyone` permission (idempotent). */
export interface SetLinkSharingRequest {
  enabled: boolean;
  /** Role granted to anyone-with-the-link when enabling. Defaults to reader. */
  role?: Exclude<ShareRole, "owner" | "writer"> | "writer";
}

// ---- role-based sharing (driveshare_* D1) ----
// NOTE: these role-grant shapes are intentionally NOT declared in @dub/types. They are
// a drive-share-service-local contract (same local-declaration convention as
// DRIVE_READ/DRIVE_WRITE in permissions.ts, which are not yet in the frozen catalog).
// The SPA consumes them via the api-gateway. If they ever stabilise into a shared
// contract they can move to @dub/types with zero wire change.

/** Drive capability assignable to a role's members. Mirrors the assignable subset of
 *  ShareRole (never `owner`). */
export type AssignableDriveRole = "reader" | "commenter" | "writer";

/** A role→file grant as shown by the file-list chips + the detail panel. `memberCount`
 *  is the number of active emails currently in the role; `appliedCount` is how many of
 *  those members now have a Drive permission in place (created by us OR a recorded
 *  pre-existing individual share). They diverge when role membership changes after the
 *  last apply — the SPA renders that drift and offers "re-apply". */
/** A role member the fan-out could NOT apply to Drive (e.g. the email has no Google
 *  account and even a notified invite failed, or the address is malformed). The apply /
 *  reapply is a PARTIAL success: the other members are granted, and these are reported
 *  with a reason so the manager can show "M人はスキップ（理由）" instead of failing wholesale. */
export interface SkippedMember {
  email: string;
  reason: string;
}

/** A role→file grant as shown by the file-list chips + the detail panel. `memberCount`
 *  is the number of active emails currently in the role; `appliedCount` is how many of
 *  those members now have a Drive permission in place (created by us OR a recorded
 *  pre-existing individual share). They diverge when role membership changes after the
 *  last apply — the SPA renders that drift and offers "re-apply". `skipped` (present only
 *  on the apply/reapply response) lists members Drive refused, with a reason each. */
export interface RoleFileGrant {
  id: string;
  fileId: string;
  roleId: string;
  roleName: string;
  driveRole: AssignableDriveRole;
  memberCount: number;
  appliedCount: number;
  grantedBy: string;
  grantedAt: string;
  skipped?: SkippedMember[];
}

/** POST /driveshare/files/:id/role-grants body. */
export interface CreateRoleGrantRequest {
  roleId: string;
  driveRole: AssignableDriveRole;
}
