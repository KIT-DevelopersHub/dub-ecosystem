// Permission-catalog helpers. The catalog itself is frozen in @dub/types
// (PERMISSION_CATALOG, 23 keys). identity-roster never re-declares it.
import { identity } from "@dub/types";

const CATALOG = identity.PERMISSION_CATALOG;
const KEY_SET: ReadonlySet<string> = new Set(CATALOG.map((e) => e.key));

/** Type guard: is `key` one of the 23 frozen catalog keys (default-deny non-members). */
export function isPermissionKey(key: string): key is identity.PermissionKey {
  return KEY_SET.has(key);
}

export function catalog(): readonly identity.PermissionCatalogEntry[] {
  return CATALOG;
}
