// github-sync permission keys.
//
// KNOWN GAP (8-N5): github:read/write/sync/admin are NOT in the frozen 23-key
// PERMISSION_CATALOG closed union. Until the catalog change lands, identity
// /authz/check default-denies unknown keys, so these endpoints return 403 in a
// real deployment. The keys are cast to identity.PermissionKey at the call site;
// this is the single documented place that cast lives.
import type { identity } from "@dub/types";

export const GITHUB_PERMISSIONS = {
  read: "github:read",
  write: "github:write",
  sync: "github:sync",
  admin: "github:admin",
} as const;

export type GithubPermission = (typeof GITHUB_PERMISSIONS)[keyof typeof GITHUB_PERMISSIONS];

/** Cast a github:* key to the frozen PermissionKey union (see 8-N5 note above). */
export function asPermissionKey(p: GithubPermission): identity.PermissionKey {
  return p as unknown as identity.PermissionKey;
}
