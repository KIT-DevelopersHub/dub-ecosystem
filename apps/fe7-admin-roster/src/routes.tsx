// FE7 route + nav definitions, exported to FE2 as the single `admin` FeatureModule.
//
// Routes are lazy (code-split) per FE2's real contract: each `lazy` dynamically
// imports its page module and returns a Component that wires FE7's
// router-agnostic NavigationContext. Permission requirements are declared via
// `requiredPermissions`; the FE2 shell enforces them, and the standalone harness
// (App.tsx) applies RouteGuard using the same field.
import type { ComponentType } from "react";
import type { FeatureModule, FeatureRoute, NavEntry } from "./shell/contract";
import { useNavigation } from "./providers/NavigationContext";
import { useRosterContext } from "./providers/RosterProvider";
import { MailRateLimitBanner } from "./components/MailRateLimitBanner";

// The roster manages each user INLINE (right pane) — selecting a name no longer
// navigates to a per-user screen (design "1画面で完結"). The `/admin/users/:userId`
// route below is kept only as a deep-link fallback (補助).
function usersRoute(): Promise<{ Component: ComponentType }> {
  return import("./components/UserListPage").then(({ UserListPage }) => ({
    Component: UserListPage,
  }));
}

function userDetailRoute(): Promise<{ Component: ComponentType }> {
  return import("./components/UserDetailPage").then(({ UserDetailPage }) => ({
    Component: function UserDetailRoute() {
      const { params } = useNavigation();
      const { me } = useRosterContext();
      return <UserDetailPage userId={params.userId ?? ""} currentUserId={me?.user.id ?? ""} />;
    },
  }));
}

// Existing-role permissions are now viewed/edited inline in RoleListPage (single
// screen), so the list no longer navigates to a per-role editor. `/admin/roles/new`
// (create) stays a dedicated screen.
function rolesRoute(): Promise<{ Component: ComponentType }> {
  return import("./components/RoleListPage").then(({ RoleListPage }) => ({
    Component: function RolesRoute() {
      const { navigate } = useNavigation();
      return <RoleListPage onNew={() => navigate("/admin/roles/new")} />;
    },
  }));
}

function roleNewRoute(): Promise<{ Component: ComponentType }> {
  return import("./components/RoleEditorPage").then(({ RoleEditorPage }) => ({
    Component: function RoleNewRoute() {
      const { navigate } = useNavigation();
      return <RoleEditorPage onDone={() => navigate("/admin/roles")} />;
    },
  }));
}

// メールアドレス管理 (/admin/email-routing) と 変更履歴 (/admin/history) は
// ユーザー明示承認で launcher/ナビから外した。route/nav を登録解除して非表示にするだけで、
// コンポーネント（EmailRoutingPage / AuditHistoryPage）は将来戻せるよう残置している。

export const routes: FeatureRoute[] = [
  { path: "/admin/users", lazy: usersRoute, auth: "required", requiredPermissions: ["identity:read"] },
  { path: "/admin/users/:userId", lazy: userDetailRoute, auth: "required", requiredPermissions: ["identity:read"] },
  { path: "/admin/roles", lazy: rolesRoute, auth: "required", requiredPermissions: ["identity:read"] },
  { path: "/admin/roles/new", lazy: roleNewRoute, auth: "required", requiredPermissions: ["identity:admin"] },
];

export const nav: NavEntry[] = [
  { label: "ユーザー名簿", path: "/admin/users", icon: "users", order: 10 },
  { label: "ロール管理", path: "/admin/roles", icon: "shield", order: 20 },
];

// headerWidget: mounted by the FE2 shell above the module surface (same slot as FE5's
// NotificationBell). It renders nothing until メール送信API is rate-limited, so the
// admin screen carries the persistent banner in production, not just the dev harness.
export const adminModule: FeatureModule = { id: "admin", routes, nav, headerWidget: MailRateLimitBanner };
