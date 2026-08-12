// Shared in-memory fakes for drive-share-service unit tests. No network, no real bindings.
import type { PermissionChecker, DrivePermission } from "../src/permissions";

/** fake PermissionChecker driven by a rule(userId, perm) => allowed. */
export function memAuthz(rule: (userId: string, perm: DrivePermission) => boolean): PermissionChecker {
  return {
    async check(userId, _orgId, permission) {
      return rule(userId, permission);
    },
  };
}

export const allowAll = memAuthz(() => true);
export const AUTHED = { "x-dub-user-id": "usr_1" };
