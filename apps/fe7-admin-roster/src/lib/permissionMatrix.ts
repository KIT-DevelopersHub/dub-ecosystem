// Pure logic for the PermissionMatrix editor and role permission-bundle diffing.
// No React here so it is exhaustively unit-testable (design §7 "matrix editor logic").
import type { identity } from "@dub/types";
import type { UpdateRoleRequest } from "../contracts/pending";

export type CatalogEntry = identity.PermissionCatalogEntry;

export interface DomainGroup {
  domain: string;
  entries: CatalogEntry[];
}

/** Group catalog entries by domain, preserving first-seen domain order. */
export function groupByDomain(catalog: readonly CatalogEntry[]): DomainGroup[] {
  const order: string[] = [];
  const byDomain = new Map<string, CatalogEntry[]>();
  for (const entry of catalog) {
    let bucket = byDomain.get(entry.domain);
    if (!bucket) {
      bucket = [];
      byDomain.set(entry.domain, bucket);
      order.push(entry.domain);
    }
    bucket.push(entry);
  }
  return order.map((domain) => ({ domain, entries: byDomain.get(domain)! }));
}

/** Selection helper: toggle a single key on/off, returning a new sorted set. */
export function togglePermission(
  selected: readonly identity.PermissionKey[],
  key: identity.PermissionKey,
): identity.PermissionKey[] {
  const set = new Set(selected);
  if (set.has(key)) set.delete(key);
  else set.add(key);
  return [...set].sort();
}

/**
 * Select/deselect every key in a domain at once. Keys in `lockedKeys` are never
 * removed by a deselect (they stay in the set) — used to protect the admin role's
 * identity:admin grant from a domain-level "off" toggle (self-lockout guard).
 */
export function toggleDomain(
  selected: readonly identity.PermissionKey[],
  entries: readonly CatalogEntry[],
  select: boolean,
  lockedKeys: readonly identity.PermissionKey[] = [],
): identity.PermissionKey[] {
  const set = new Set(selected);
  const locked = new Set(lockedKeys);
  for (const e of entries) {
    const key = e.key as identity.PermissionKey;
    if (select) set.add(key);
    else if (!locked.has(key)) set.delete(key);
  }
  return [...set].sort();
}

export interface DomainSelectionState {
  all: boolean;
  some: boolean; // indeterminate when some && !all
}

/** Header checkbox state for a domain given the current selection. */
export function domainSelectionState(
  selected: readonly identity.PermissionKey[],
  entries: readonly CatalogEntry[],
): DomainSelectionState {
  const set = new Set(selected);
  let count = 0;
  for (const e of entries) if (set.has(e.key as identity.PermissionKey)) count++;
  return { all: count === entries.length && entries.length > 0, some: count > 0 };
}

/**
 * Keys that must stay granted on a role and cannot be toggled off (self-lockout
 * guard). Today only the built-in admin role is protected: stripping identity:admin
 * from it would leave nobody able to manage roles/permissions, locking everyone out.
 */
export function lockedKeysForRole(role: { name: string; isSystem: boolean }): identity.PermissionKey[] {
  // The admin role also keeps the 管理 app's per-app access keys: now that opening the
  // 管理 app is gated on app:admin:view (route guard + launcher), stripping it would lock
  // admins out of the very screen that manages roles. Freeze both view+edit ON.
  return role.isSystem && role.name === "admin"
    ? ["identity:admin", "app:admin:view", "app:admin:edit"]
    : [];
}

/** True if selecting `key` requires an extra confirmation (dangerous flag). */
export function isDangerous(catalog: readonly CatalogEntry[], key: string): boolean {
  return catalog.some((e) => e.key === key && e.dangerous);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

/**
 * Build the PATCH body carrying ONLY changed fields (design §2-4 "差分のみ" and
 * test "差分のみ UpdateRoleRequest に載る"). Returns null when nothing changed.
 */
export function buildRoleUpdate(
  original: { name: string; permissions: readonly identity.PermissionKey[] },
  next: { name: string; permissions: readonly identity.PermissionKey[] },
): UpdateRoleRequest | null {
  const patch: UpdateRoleRequest = {};
  if (next.name !== original.name) patch.name = next.name;
  if (!sameSet(original.permissions, next.permissions)) {
    patch.permissions = [...next.permissions].sort();
  }
  return Object.keys(patch).length === 0 ? null : patch;
}
