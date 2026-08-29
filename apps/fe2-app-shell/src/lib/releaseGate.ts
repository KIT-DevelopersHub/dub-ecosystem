// Member release-gating (社長決定 2026-08-14). A single source of truth for which
// apps are published to GENERAL MEMBERS. Any app NOT explicitly published here is
// shown to members greyed-out in the launcher (消さない — never removed) so an app
// that is merely deployed but not yet announced can't be mistaken for a released
// feature and used by accident. ONLY full admins (identity:admin) bypass the gate so
// they can test & develop unreleased apps; non-admin operator roles (maintainer /
// organizer) are gated like general members (社長決定 #255, 2026-08-17).
//
// Release lifecycle (3 steps): (1) demo env → (2) prod, deployed but member-hidden
// = greyed, admin/dev only → (3) prod, member-published = greyed removed. Moving an
// app to step (3) is a ONE-LINE change here (add its id to PUBLISHED_APPS).
//
// v1 is config-driven on purpose. A future admin UI can replace this constant with
// a server-backed per-app flag (e.g. an `apps.memberPublished` column surfaced on
// /me) without touching the launcher/route call-sites: keep isAppPublished() as the
// single lookup and swap its body for the fetched flag.
import { appRegistry, type identity } from "@dub/types";
import type { FeatureModuleId } from "../modules/types.tsx";

type PermissionKey = identity.PermissionKey;

/** Apps published to general members as of 2026-08-14. Only メール (mail) is live;
 *  everything else is admin/dev-only (greyed for members) until announced. */
export const PUBLISHED_APPS: ReadonlySet<FeatureModuleId> = new Set<FeatureModuleId>(["mail"]);

/** Tooltip shown on a member's greyed (unpublished) launcher tile. */
export const UNPUBLISHED_TILE_REASON = "準備中（メンバー未公開）";

/** Tooltip shown on a launcher tile the viewer lacks the permission to open. Kept
 *  consistent with the route guard (router.tsx RequirePermission → 403): an app whose
 *  requiredPermissions the viewer does not hold is greyed rather than removed. Applies
 *  to everyone, admins included, so it never contradicts the actual per-route authz. */
export const UNAUTHORIZED_TILE_REASON = "権限がありません（アクセス不可）";

/** True when the app is published to general members. An unknown/undefined appId
 *  defaults to published so bare test fixtures (nav entries without an appId) are
 *  never accidentally greyed — the real shell always tags composition nav. */
export function isAppPublished(appId: FeatureModuleId | undefined): boolean {
  return appId === undefined || PUBLISHED_APPS.has(appId);
}

// Admin-only bypass (社長決定 #255, 2026-08-17). "Privileged" = a FULL admin who may
// see every app while it is still member-hidden. Earlier this was derived from holding
// ANY `dangerous` catalog permission, which wrongly let non-admin operator roles
// (maintainer/organizer — they hold *:admin / *:send perms) bypass the gate too. The
// bypass is now the single `identity:admin` capability, so the launcher, the dashboard
// app grid and the route guard (all call isPrivilegedViewer) agree: only admins see
// unpublished apps; everyone else is gated to member-published apps (メール).
const ADMIN_PERMISSION: PermissionKey = "identity:admin";

/** True when the viewer is a full admin (bypasses the member release gate).
 *  `can` is the shell's fail-closed permission check (false while /me loads), so a
 *  loading/unauthenticated viewer is treated as a non-privileged member. */
export function isPrivilegedViewer(can: (p: PermissionKey) => boolean): boolean {
  return can(ADMIN_PERMISSION);
}

/**
 * True when the viewer holds the app's EXPLICIT per-app access grant (app:<id>:view,
 * #270). Granting a role an app in ロール管理 IS the decision to release that app to that
 * role, so an explicit grant must override the coarse member-publish gate below.
 * Fail-closed: false for an unknown app id or while /me loads (can() returns false).
 */
export function hasExplicitAppAccess(
  appId: FeatureModuleId | undefined,
  can: (p: PermissionKey) => boolean,
): boolean {
  if (!appId) return false;
  const viewKey = appRegistry.appViewKey(appId);
  return viewKey ? can(viewKey as PermissionKey) : false;
}

/**
 * True when the member-publish release gate should GREY this app for the viewer.
 *
 * BUGFIX (#270 follow-up): the launcher/route used to grey any app that was not in
 * PUBLISHED_APPS for every non-admin — even after ロール管理 granted the role app:<id>:view.
 * That double-gated the per-app RBAC: a granted organizer still saw the tile disabled.
 * The per-app grant is now authoritative — an app is RELEASED to a viewer who is (a) a
 * full admin, (b) explicitly granted the app (hasExplicitAppAccess), or (c) globally
 * member-published (PUBLISHED_APPS). Only an app with NONE of these (unannounced AND
 * ungranted) stays greyed for general members, preserving the "don't surface unreleased
 * apps by accident" intent for roles that were never granted them.
 */
export function isReleaseGatedFor(
  appId: FeatureModuleId | undefined,
  can: (p: PermissionKey) => boolean,
): boolean {
  return !isPrivilegedViewer(can) && !isAppPublished(appId) && !hasExplicitAppAccess(appId, can);
}
