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

function usersRoute(): Promise<{ Component: ComponentType }> {
  return import("./components/UserListPage").then(({ UserListPage }) => ({
    Component: function UsersRoute() {
      const { navigate } = useNavigation();
      return <UserListPage onOpenUser={(id) => navigate(`/admin/users/${id}`)} />;
    },
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

function historyRoute(): Promise<{ Component: ComponentType }> {
  return import("./components/AuditHistoryPage").then(({ AuditHistoryPage }) => ({
    Component: AuditHistoryPage,
  }));
}

function emailRoutingRoute(): Promise<{ Component: ComponentType }> {
  return import("./components/EmailRoutingPage").then(({ EmailRoutingPage }) => ({
    Component: EmailRoutingPage,
  }));
}

export const routes: FeatureRoute[] = [
  { path: "/admin/users", lazy: usersRoute, auth: "required", requiredPermissions: ["identity:read"] },
  { path: "/admin/users/:userId", lazy: userDetailRoute, auth: "required", requiredPermissions: ["identity:read"] },
  { path: "/admin/roles", lazy: rolesRoute, auth: "required", requiredPermissions: ["identity:read"] },
  { path: "/admin/roles/new", lazy: roleNewRoute, auth: "required", requiredPermissions: ["identity:admin"] },
  { path: "/admin/email-routing", lazy: emailRoutingRoute, auth: "required", requiredPermissions: ["mail:admin"] },
  { path: "/admin/history", lazy: historyRoute, auth: "required", requiredPermissions: ["audit:read"] },
];

export const nav: NavEntry[] = [
  { label: "ユーザー名簿", path: "/admin/users", icon: "users", order: 10 },
  { label: "ロール管理", path: "/admin/roles", icon: "shield", order: 20 },
  { label: "メールアドレス管理", path: "/admin/email-routing", icon: "inbox", order: 25 },
  { label: "変更履歴", path: "/admin/history", icon: "history", order: 30 },
];

// headerWidget: mounted by the FE2 shell above the module surface (same slot as FE5's
// NotificationBell). It renders nothing until メール送信API is rate-limited, so the
// admin screen carries the persistent banner in production, not just the dev harness.
export const adminModule: FeatureModule = { id: "admin", routes, nav, headerWidget: MailRateLimitBanner };
