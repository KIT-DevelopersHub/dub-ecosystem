// Authz keys. drive:read / drive:write are NOT (yet) in the frozen PERMISSION_CATALOG
// closed union in @dub/types (same pending contract-change drive-proxy is waiting on).
// We must not edit the frozen package, so the two keys live here as string constants
// and are treated as opaque permission keys by the injected authz checker. When the
// catalog adds them, callers move to identity.PermissionKey with zero behavioural
// change (the wire string is identical). Reads require drive:read; every mutation
// (grant / role change / revoke / link toggle) requires drive:write.
export const DRIVE_READ = "drive:read" as const;
export const DRIVE_WRITE = "drive:write" as const;

export type DrivePermission = typeof DRIVE_READ | typeof DRIVE_WRITE;

/** Abstracts identity /authz/check so routes stay testable without a Fetcher. */
export interface PermissionChecker {
  check(userId: string, orgId: string, permission: DrivePermission): Promise<boolean>;
}
