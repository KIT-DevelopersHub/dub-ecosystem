// Members FeatureModule source (authored against FE2's canonical contract, like mail
// and FE3–FE7). The shell's composition (featureModules.tsx) wraps these routes in
// MembersProvider fed by the one api-client and merges the nav ordering.
//
// 運営メンバー管理 is an org-people administration surface, so it reuses the identity
// permission gates (view = identity:read; the screen's write actions are re-checked
// server-side against identity:admin) rather than introducing new catalog keys.
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
    path: "/members",
    lazy: () => Promise.resolve({ Component: MembersPage }),
    auth: "required",
    requiredPermissions: ["identity:read"],
  },
  {
    // 運営名簿: 運営メンバー全員をフラットな一覧で並べる名簿ビュー（/members と同じ Provider・
    // 共有サブナビ配下・同じ requiredPermissions）。
    path: "/members/roster",
    lazy: () => Promise.resolve({ Component: MemberRosterPage }),
    auth: "required",
    requiredPermissions: ["identity:read"],
  },
];

export const membersNav: MembersNavEntry[] = [{ label: "運営メンバー", path: "/members", icon: "users" }];
