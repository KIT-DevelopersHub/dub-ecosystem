// Members FeatureModule source (authored against FE2's canonical contract, like mail
// and FE3–FE7). The shell's composition (featureModules.tsx) wraps these routes in
// MembersProvider fed by the one api-client and merges the nav ordering.
//
// 運営メンバー管理 is an org-people administration surface. Opening it is gated on the
// per-app key app:members:view (ANDed onto the module by withAppAccessGate in the shell
// composition — the AUTHORITATIVE 有効化 gate), NOT on the domain key identity:read: a
// 統括 role granted the app in ロール管理 must be able to open the roster without full
// identity:read. The server (member-service) accepts identity:read OR app:members:view
// for reads and identity:admin OR app:members:edit for writes, matching this.
import type { ComponentType } from "react";
import type { identity } from "@dub/types";
import type { IconName } from "@dub/ui";
import { MembersPage } from "./MembersPage.tsx";
import { MemberRosterPage } from "./MemberRosterPage.tsx";

type PermissionKey = identity.PermissionKey;

export interface MembersSourceRoute {
  path: string;
  lazy: () => Promise<{ Component: ComponentType }>;
  auth: "required" | "public";
  requiredPermissions?: PermissionKey[];
}
export interface MembersNavEntry {
  label: string;
  path: string;
  icon: IconName;
}

export const membersRoutes: MembersSourceRoute[] = [
  {
    // Gate = app:members:view only (ANDed by withAppAccessGate). No route-level
    // identity:read: the per-app key is the authoritative 有効化 gate so a 統括 role can
    // open the roster without the domain key.
    path: "/members",
    lazy: () => Promise.resolve({ Component: MembersPage }),
    auth: "required",
  },
  {
    // 運営名簿: 運営メンバー全員をフラットな一覧で並べる名簿ビュー（/members と同じ Provider・
    // 共有サブナビ配下・同じゲート app:members:view）。
    path: "/members/roster",
    lazy: () => Promise.resolve({ Component: MemberRosterPage }),
    auth: "required",
  },
];

export const membersNav: MembersNavEntry[] = [{ label: "運営メンバー", path: "/members", icon: "users" }];
