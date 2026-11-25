// Staging-only: keep role_sys_admin ⊇ PERMISSION_CATALOG on the staging D1s.
// New catalog keys reach admin through data-only migrations (INSERT OR IGNORE, e.g.
// identity/0028). Prod gets them when the owner runs every migration file; the staging
// schema sync only applies files that fill a missing table/column, so data-only grants
// never land there and admin on staging falls behind the catalog.
// scripts/grant-staging-admin.ts runs this on every staging deploy.
import { identity } from "@dub/types";

export const SYS_ADMIN_ROLE_ID = "role_sys_admin";

/** Staging D1 names only (dub-core-staging, dub-core-staging2, ...). Never prod. */
export const STAGING_DB = /^dub-core-staging\d*$/;

const KEY = /^[a-z0-9_:.-]+$/;

/** One idempotent statement granting role_sys_admin every key; no-op if the role is absent. */
export function stagingAdminGrantSql(
  keys: readonly string[] = identity.PERMISSION_CATALOG.map((e) => e.key),
): string {
  if (keys.length === 0) throw new Error("empty permission catalog");
  for (const k of keys) {
    if (!KEY.test(k)) throw new Error(`unexpected permission key: ${k}`);
  }
  const values = keys.map((k) => `('${k}')`).join(",");
  return (
    `INSERT OR IGNORE INTO identity_role_permissions (role_id, permission_key) ` +
    `SELECT '${SYS_ADMIN_ROLE_ID}', column1 FROM (VALUES ${values}) ` +
    `WHERE EXISTS (SELECT 1 FROM identity_roles WHERE id = '${SYS_ADMIN_ROLE_ID}');`
  );
}
