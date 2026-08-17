// Member release-gating (社長決定 2026-08-14). A single source of truth for which
// apps are published to GENERAL MEMBERS. Any app NOT explicitly published here is
// shown to members greyed-out in the launcher (消さない — never removed) so an app
// that is merely deployed but not yet announced can't be mistaken for a released
// feature and used by accident. Admins / maintainers bypass the gate entirely so
// they can test & develop unreleased apps.
//
// Release lifecycle (3 steps): (1) demo env → (2) prod, deployed but member-hidden
// = greyed, admin/dev only → (3) prod, member-published = greyed removed. Moving an
// app to step (3) is a ONE-LINE change here (add its id to PUBLISHED_APPS).
//
// v1 is config-driven on purpose. A future admin UI can replace this constant with
// a server-backed per-app flag (e.g. an `apps.memberPublished` column surfaced on
// /me) without touching the launcher/route call-sites: keep isAppPublished() as the
// single lookup and swap its body for the fetched flag.
import { identity } from "@dub/types";
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

// Admin/maintainer bypass. There is no role field on MeResponse (only the resolved
// permission set), so "privileged" (an operator/developer who may see every app) is
// derived from the frozen RBAC catalog: holding ANY permission flagged `dangerous`
// (identity:admin, *:admin, mail:send, infra:deploy, …) marks the admin & maintainer
// tiers; the member tier (read-only perms) holds none. Self-maintaining: new catalog
// keys are classified by their own `dangerous` flag.
const PRIVILEGED_KEYS: readonly PermissionKey[] = identity.PERMISSION_CATALOG.filter(
  (e) => e.dangerous,
).map((e) => e.key);

/** True when the viewer is an admin/maintainer (bypasses the member release gate).
 *  `can` is the shell's fail-closed permission check (false while /me loads), so a
 *  loading/unauthenticated viewer is treated as a non-privileged member. */
export function isPrivilegedViewer(can: (p: PermissionKey) => boolean): boolean {
  return PRIVILEGED_KEYS.some((k) => can(k));
}
