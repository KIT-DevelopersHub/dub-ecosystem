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
   * The PER-APP graded access keys that INDIVIDUALLY govern this app (domain "app").
   * `view` = 有効化 (the app can be opened/viewed) — the actual launcher-grey + route-guard
   * gate; `edit` implies view and additionally allows create/edit inside the app (write
   * UIs gate on it). Every app has its OWN pair (unlike `permissions` above, which for
   * gantt/participation is a SHARED domain key), so an admin can turn each app on/off per
   * role without collateral. Both keys are `PermissionKey` (closed union) so a typo is a
   * compile error; the CI test asserts they exist in PERMISSION_CATALOG under domain "app".
   */
  access: { view: PermissionKey; edit: PermissionKey };
  /**
   * The FINE-GRAINED (non per-app) catalog keys this app owns — what ロール管理 shows in the
   * app's 詳細設定 dialog once the 3-tier level is set. REQUIRED (not optional) so adding an
   * app forces the author to declare its detailed scope; `[]` is a legitimate, explicit
   * answer for an app that has no knob beyond 無効/閲覧/編集 (gantt, 参加届, LP管理).
   *
   * INVARIANT (CI: app-registry.test.ts): a non-`app` catalog key is claimed by AT MOST one
   * app — so 詳細 dialogs never double-show a key, and gantt/参加届 (which SHARE another app's
   * domain key) declare `[]` rather than re-claiming the task / identity keys. Every key NOT
   * claimed here is, by construction, an 「その他」 key (policy.otherPermissions()), so a newly
   * added catalog key can never fall out of the ロール管理 UI — it just lands in その他 until an
   * app claims it. Never `app:*` keys (those are the graded tier in `access`).
   */
  detailPermissions: readonly PermissionKey[];
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
  { id: "events", label: "イベント", navPath: "/events", domain: "event", permissions: ["event:read"], access: { view: "app:events:view", edit: "app:events:edit" },
    detailPermissions: ["event:read", "event:write", "event:admin"] },
  { id: "tasks", label: "マイタスク", navPath: "/me/tasks", domain: "task", permissions: ["task:read"], access: { view: "app:tasks:view", edit: "app:tasks:edit" },
    detailPermissions: ["task:read", "task:write", "task:delete"] },
  // gantt reads the SAME task:* domain keys as マイタスク. Claiming them here too would show
  // one key in two 詳細 dialogs, so ガント owns no fine-grained key: 無効/閲覧/編集 is its whole
  // surface (its own app:gantt:* pair still toggles it independently of マイタスク).
  { id: "gantt", label: "ガントチャート", navPath: "/gantt", domain: "task", permissions: ["task:read"], access: { view: "app:gantt:view", edit: "app:gantt:edit" },
    detailPermissions: [] },
  // カレンダー also rides マイタスク's task:* keys (see gantt) → no own fine-grained key.
  { id: "calendar", label: "カレンダー", navPath: "/calendar", domain: "task", permissions: ["task:read"], access: { view: "app:calendar:view", edit: "app:calendar:edit" },
    detailPermissions: [] },
  { id: "notifications", label: "通知", navPath: "/notifications", domain: "notif", permissions: ["notif:inbox:self"], access: { view: "app:notifications:view", edit: "app:notifications:edit" },
    detailPermissions: ["notif:inbox:self", "notif:prefs:self", "notif:send", "notif:admin", "notif:broadcast_publish"] },
  { id: "chat", label: "チャット", navPath: "/chat", domain: "chat", permissions: ["chat:create"], access: { view: "app:chat:view", edit: "app:chat:edit" },
    detailPermissions: ["chat:create", "chat:moderate"] },
  { id: "mail", label: "メール", navPath: "/mail", domain: "mail", permissions: ["mail:read"], access: { view: "app:mail:view", edit: "app:mail:edit" },
    detailPermissions: ["mail:read", "mail:send", "mail:read_all", "mail:read_role_shared", "mail:admin"] },
  { id: "usage", label: "無料枠 / 課金ガード", navPath: "/usage", domain: "usage", permissions: ["usage:view"], access: { view: "app:usage:view", edit: "app:usage:edit" }, openToAllAuthenticated: true,
    detailPermissions: ["usage:view"] },
  // 運営メンバー owns the WHOLE identity:* surface (roster AND role administration): the
  // 名簿・ロール story belongs inside the roster app, so identity:admin lives in this app's
  // 詳細設定 rather than ロール管理's.
  { id: "members", label: "運営メンバー", navPath: "/members", domain: "identity", permissions: ["identity:read"], access: { view: "app:members:view", edit: "app:members:edit" },
    detailPermissions: ["identity:read", "identity:admin"] },
  // 参加届 rides 運営メンバー's identity:* keys (see gantt above) → no own fine-grained key.
  { id: "participation", label: "参加届", navPath: "/participation", domain: "identity", permissions: ["identity:read"], access: { view: "app:participation:view", edit: "app:participation:edit" }, openToAllAuthenticated: true,
    detailPermissions: [] },
  // Drive共有 is the ecosystem's file surface: the Google Drive keys AND the R2 file:* keys
  // (upload/download/visibility) are both configured here — file:* previously belonged to no
  // app and fell into 「その他」, which hid ファイル settings from the app they act on.
  { id: "driveshare", label: "Drive共有", navPath: "/driveshare", domain: "drive", permissions: ["drive:read"], access: { view: "app:driveshare:view", edit: "app:driveshare:edit" }, openToAllAuthenticated: true,
    detailPermissions: ["drive:read", "drive:write", "file:read", "file:write", "file:admin"] },
  // LP管理 reads infra:read, but infra:* governs the whole デプロイ/DNS surface (not just LP),
  // so those keys stay in 「その他」 instead of being scoped to this app's 詳細 dialog.
  { id: "lp", label: "LP管理", navPath: "/lp", domain: "infra", permissions: ["infra:read"], access: { view: "app:lp:view", edit: "app:lp:edit" },
    detailPermissions: [] },
  // identity:admin is claimed by 運営メンバー's 詳細設定 (名簿・ロールの話は名簿アプリの中)。
  // ロール管理 itself has no knob beyond 無効/閲覧/編集 — that 3 段階 is its whole settings surface.
  { id: "admin", label: "ロール管理", navPath: "/admin/roles", domain: "identity", permissions: ["identity:admin"], access: { view: "app:admin:view", edit: "app:admin:edit" },
    detailPermissions: [] },
  // Commander: admin/dev tooling that drives the LOCAL Claude Code exec bridge and gates
  // demo→staging→prod phase moves. Admin-only by design (identity:admin) and NOT in the
  // launcher's PUBLISHED_APPS, so it is greyed (member-hidden) until explicitly released.
  // identity:admin is claimed by 運営メンバー's 詳細設定 (a non-app key belongs to at most one
  // app), so Commander — like ロール管理 — has no knob beyond 無効/閲覧/編集.
  { id: "commander", label: "Commander", navPath: "/commander", domain: "identity", permissions: ["identity:admin"], access: { view: "app:commander:view", edit: "app:commander:edit" },
    detailPermissions: [] },
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

/** The per-app graded access key(s) for one app (view = open/閲覧, edit = 編集・作成). */
export function appAccessKeys(id: string): { view: PermissionKey; edit: PermissionKey } | undefined {
  return getApp(id)?.access;
}

/** Every per-app access key (view+edit for all apps), in launcher order. */
export function allAppAccessKeys(): PermissionKey[] {
  return APP_MANIFEST.flatMap((a) => [a.access.view, a.access.edit]);
}

/** The `app:<id>:view` gate key for one app (undefined for an unknown id). */
export function appViewKey(id: string): PermissionKey | undefined {
  return getApp(id)?.access.view;
}

/** The `app:<id>:edit` gate key for one app (undefined for an unknown id). */
export function appEditKey(id: string): PermissionKey | undefined {
  return getApp(id)?.access.edit;
}

/**
 * The DOMAIN permission key(s) that back an app — the keys a role must ALSO hold for a
 * per-app grant to be EFFECTIVE (the app's service reads gate on these). Empty for an
 * unknown id. E.g. "members" → ["identity:read"], "events" → ["event:read"].
 */
export function appDomainKeys(id: string): readonly PermissionKey[] {
  return getApp(id)?.permissions ?? [];
}

/**
 * Normalize a role's selected permission set so every per-app access key it holds is
 * EFFECTIVE, not merely cosmetic. Closes the 抜け that made ロール管理 per-app toggles
 * front-end-only: turning an app on granted just the `app:<id>:view|edit` key, so the
 * app's DOMAIN API still 403'd (the toggle never became real 実効権限).
 *
 * For each app the set references it ensures:
 *   (a) `app:<id>:edit` co-carries `app:<id>:view` (edit ⇒ view), and
 *   (b) holding either per-app key also grants the DOMAIN read key(s) the app needs
 *       to function (appDomainKeys — e.g. identity:read for 運営メンバー).
 *
 * Pure + idempotent (safe to run on every save). It ONLY adds domain READ keys — never
 * domain write/admin — so granting e.g. app:members:edit delegates 名簿編集 WITHOUT
 * escalating the role to identity:admin (minimal escalation).
 */
export function withRequiredAppDomainKeys(perms: readonly PermissionKey[]): PermissionKey[] {
  const set = new Set<PermissionKey>(perms);
  for (const app of APP_MANIFEST) {
    const hasEdit = set.has(app.access.edit);
    const hasView = set.has(app.access.view);
    if (!hasEdit && !hasView) continue;
    if (hasEdit) set.add(app.access.view); // edit ⇒ view
    for (const key of app.permissions) set.add(key); // domain read key(s)
  }
  return [...set].sort();
}
