// 参加届 FeatureModule source (authored against FE2's canonical contract, like mail /
// members). The shell's composition (featureModules.tsx) wraps these routes in
// ParticipationProvider fed by the one api-client and merges the nav ordering.
//
// The submit endpoint is open to any authenticated 運営 (they file their own 届), so
// the route carries auth:"required" with NO requiredPermissions — the launcher tile
// shows for every signed-in user. Write reflection onto the roster is re-authorized
// server-side by member-service.
import type { ComponentType } from "react";
import type { identity } from "@dub/types";
import type { IconName } from "@dub/ui";
import { OnboardingAdminPage } from "./OnboardingAdminPage.tsx";
import { ParticipationListPage } from "./ParticipationListPage.tsx";

type PermissionKey = identity.PermissionKey;

export interface ParticipationSourceRoute {
  path: string;
  lazy: () => Promise<{ Component: ComponentType }>;
  auth: "required" | "public";
  requiredPermissions?: PermissionKey[];
}
export interface ParticipationNavEntry {
  label: string;
  path: string;
  icon: IconName;
  requiredPermissions?: PermissionKey[];
}

export const participationRoutes: ParticipationSourceRoute[] = [
  {
    // オンボーディング管理タブ。旧・アプリ内の参加届フォームは廃止（新メンバーはまだアカウントが
    // 無いので公開フォーム /participate を使う。その URL は回答一覧に出す）。項目の読み取りは
    // 参加届の閲覧で足り、書き込みは member-service が参加届の編集を要求する。
    path: "/participation",
    lazy: () => Promise.resolve({ Component: OnboardingAdminPage }),
    auth: "required",
  },
  {
    // 回答一覧 (運営専用). identity:read = member-service の list ゲートと一致。
    path: "/participation/list",
    lazy: () => Promise.resolve({ Component: ParticipationListPage }),
    auth: "required",
    requiredPermissions: ["identity:read"],
  },
];

export const participationNav: ParticipationNavEntry[] = [
  { label: "オンボーディング", path: "/participation", icon: "check-square" },
  { label: "参加届の回答一覧", path: "/participation/list", icon: "users", requiredPermissions: ["identity:read"] },
];

// PUBLIC standalone route (unauthenticated). Mounted by the shell router OUTSIDE the
// authenticated shell (sibling of /login) so participants can submit without signing in.
// Kept distinct from the in-shell "/participation" tile (which 運営 use while signed in).
export const PUBLIC_PARTICIPATION_PATH = "/participate";

// PUBLIC オンボーディング案内 (unauthenticated, read-only)。/participate と同じくシェルの外。
export const PUBLIC_ONBOARDING_PATH = "/onboarding";
