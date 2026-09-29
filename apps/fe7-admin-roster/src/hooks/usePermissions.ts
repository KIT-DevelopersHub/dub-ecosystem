// Thin wrapper over FE2's can(permission). Sources org-wide effective permissions
// from MeResponse.permissions (frozen gateway.MeResponse). Fail-closed while me
// is null (design §7 usePermissions test).
import { useCallback } from "react";
import type { identity } from "@dub/types";
import { policy } from "@dub/types";
import { useRosterContext } from "../providers/RosterProvider";
import { canWith, canAll } from "../lib/permissions";

export interface UsePermissions {
  can: (permission: identity.PermissionKey) => boolean;
  canAll: (permissions: readonly identity.PermissionKey[]) => boolean;
  /** 3 段階 capability flags for an app (`readOnly` = 閲覧のみ ⇒ ボタンを disabled にする). */
  appCan: (appId: string) => policy.AppCapability;
  /**
   * THE mirror of the server's policy gate: same module, same requirement shape as
   * @dub/auth-client `requireAppAccess` / identity-roster's requireAdminEdit. Use it for
   * write affordances so a disabled button and a 403 can never disagree (閲覧 の管理者に
   * 押せる保存ボタンを見せない).
   */
  decide: (req: policy.PolicyRequirement) => policy.PolicyDecision;
  ready: boolean; // false while me is loading
}

export function usePermissions(): UsePermissions {
  const { me } = useRosterContext();
  const permissions = me?.permissions ?? null;
  const can = useCallback((p: identity.PermissionKey) => canWith(permissions, p), [permissions]);
  const all = useCallback((ps: readonly identity.PermissionKey[]) => canAll(permissions, ps), [permissions]);
  // Prefer the level map the gateway already derived (/me appAccess); fall back to deriving
  // it from `permissions` with the same policy module. Fail-closed while me is null.
  const appCan = useCallback(
    (appId: string): policy.AppCapability => policy.appCapability(permissions ?? [], appId),
    [permissions],
  );
  const decide = useCallback(
    (req: policy.PolicyRequirement): policy.PolicyDecision => policy.decide(permissions ?? [], req),
    [permissions],
  );
  return { can, canAll: all, appCan, decide, ready: me !== null };
}

/** 管理アプリ(ロール管理 / メール名簿)を編集できるか — identity-roster の requireAdminEdit と同条件。 */
export function useCanAdminEdit(): boolean {
  const { decide } = usePermissions();
  return decide({ app: "admin", level: policy.AppAccessLevel.Edit, permission: "identity:admin" }).allowed;
}
