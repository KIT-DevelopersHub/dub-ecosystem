// app-registry — the single source of truth for the canonical set of ecosystem
// "apps" (the tiles in the 9-dot AppLauncher). This registry is what (a) the shell
// launcher/nav SHOULD derive its tile set from, (b) binds each app to its per-app
// RBAC permission key(s), and (c) lets the FE7 permission matrix map a permission
// domain back to the app it governs.
//
// WHY this exists (the 抜け漏れ this closes):
//   Historically a new app (its launcher tile + routes) could ship WITHOUT anyone
//   adding a per-app permission key to PERMISSION_CATALOG, so the app had no RBAC
//   surface — invisible in FE7's role matrix, ungovernable. This registry makes the
//   app↔permission link EXPLICIT and machine-checkable:
//     - `permissions` is typed `readonly PermissionKey[]` (the closed catalog union),
//       so referencing a non-existent key is a COMPILE error (pnpm typecheck fails).
//     - a CI test (packages/types/test/app-registry.test.ts) asserts every app's keys
//       exist in PERMISSION_CATALOG and every app declares ≥1 key.
//     - a CI test (apps/fe2-app-shell) asserts every ASSEMBLED launcher feature-module
//       id has an entry here — so adding an app without registering it (and thus
//       without a permission) turns CI red = un-mergeable.
//
// Adding a new app therefore forces the author through: declare it here → declare its
// per-app permission key(s) → (if new) add the key to PERMISSION_CATALOG → labels in
// FE7. Forget any step and CI fails.
import type { PermissionKey } from "./identity";

export interface AppManifestEntry {
  /** Canonical app id. MUST equal the shell FeatureModule.id (composition/featureModules). */
  id: string;
  /** Japanese display name (launcher tile / docs). */
  label: string;
  /** Primary launcher/nav path this app is reached at. */
  navPath: string;
  /** The PERMISSION_CATALOG `domain` that backs this app (matrix grouping). */
  domain: string;
  /**
   * The per-app RBAC permission key(s) that govern viewing/using this app. At least
   * one, and every entry MUST be a key present in PERMISSION_CATALOG (enforced by the
   * closed `PermissionKey` union at compile time + the CI test). For apps whose FE
   * launcher tile is intentionally open to any authenticated user (e.g. usage,
   * participation submit, driveshare view), this still names the catalog key that
   * governs the app so the app is representable/toggleable in the RBAC matrix; the
   * runtime gate (open vs enforced) is owned by each app/service and unchanged here.
   */
  permissions: readonly PermissionKey[];
  /**
   * True when the launcher tile is shown to every authenticated user regardless of the
   * permission above (the permission still exists for matrix representation + future
   * enforcement). Documentation of intent; not an authz decision.
   */
  openToAllAuthenticated?: boolean;
}

// The canonical app set, in launcher order. Keep in lockstep with the shell's
// assembleFeatureModules() id list (composition/featureModules.tsx) — the CI cross-check
// enforces it.
export const APP_MANIFEST = [
  { id: "events", label: "イベント", navPath: "/events", domain: "event", permissions: ["event:read"] },
  { id: "tasks", label: "マイタスク", navPath: "/me/tasks", domain: "task", permissions: ["task:read"] },
  { id: "gantt", label: "ガントチャート", navPath: "/gantt", domain: "task", permissions: ["task:read"] },
  { id: "notifications", label: "通知", navPath: "/notifications", domain: "notif", permissions: ["notif:inbox:self"] },
  { id: "chat", label: "チャット", navPath: "/chat", domain: "chat", permissions: ["chat:create"] },
  { id: "mail", label: "メール", navPath: "/mail", domain: "mail", permissions: ["mail:read"] },
  { id: "usage", label: "無料枠 / 課金ガード", navPath: "/usage", domain: "usage", permissions: ["usage:view"], openToAllAuthenticated: true },
  { id: "members", label: "運営メンバー", navPath: "/members", domain: "identity", permissions: ["identity:read"] },
  { id: "participation", label: "参加届", navPath: "/participation", domain: "identity", permissions: ["identity:read"], openToAllAuthenticated: true },
  { id: "driveshare", label: "Drive共有", navPath: "/driveshare", domain: "drive", permissions: ["drive:read"], openToAllAuthenticated: true },
  { id: "admin", label: "管理", navPath: "/admin/users", domain: "identity", permissions: ["identity:admin"] },
] as const satisfies readonly AppManifestEntry[];

/** Canonical app id union (derived from the manifest). */
export type AppId = (typeof APP_MANIFEST)[number]["id"];

/** All canonical launcher app ids, in launcher order. */
export const APP_IDS: readonly AppId[] = APP_MANIFEST.map((a) => a.id);

/** Look up a manifest entry by app id. */
export function getApp(id: string): AppManifestEntry | undefined {
  return APP_MANIFEST.find((a) => a.id === id);
}

/** True iff `id` is a canonical (registered) launcher app. */
export function isCanonicalAppId(id: string): id is AppId {
  return APP_MANIFEST.some((a) => a.id === id);
}

/** The union of every per-app permission key referenced by the manifest. */
export function manifestPermissionKeys(): PermissionKey[] {
  return [...new Set(APP_MANIFEST.flatMap((a) => a.permissions))];
}
