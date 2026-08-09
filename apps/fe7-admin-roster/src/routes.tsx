// FE7 route + nav definitions, exposed to FE2 as `adminModule: FeatureModule`.
// Guards are PermissionKey-based (frozen 1-2-2). Paths are flat under /admin.
import type { FeatureModule, FeatureRoute, NavEntry } from "./shell/contract";
import { RouteGuard } from "./components/RouteGuard";
import { UserListPage } from "./components/UserListPage";
import { UserDetailPage } from "./components/UserDetailPage";
import { RoleListPage } from "./components/RoleListPage";
import { RoleEditorPage } from "./components/RoleEditorPage";
import { AuditHistoryPage } from "./components/AuditHistoryPage";
import { useRosterContext } from "./providers/RosterProvider";
import { useNavigation } from "./providers/NavigationContext";

function UsersRoute() {
  const { navigate } = useNavigation();
  return (
    <RouteGuard requiredPermissions={["identity:read"]}>
      <UserListPage onOpenUser={(id) => navigate(`/admin/users/${id}`)} />
    </RouteGuard>
  );
}

function UserDetailRoute() {
  const { params } = useNavigation();
  const { me } = useRosterContext();
  return (
    <RouteGuard requiredPermissions={["identity:read"]}>
      <UserDetailPage userId={params.userId ?? ""} currentUserId={me?.user.id ?? ""} />
    </RouteGuard>
  );
}

function RolesRoute() {
  const { navigate } = useNavigation();
  return (
    <RouteGuard requiredPermissions={["identity:read"]}>
      <RoleListPage onNew={() => navigate("/admin/roles/new")} onEdit={(id) => navigate(`/admin/roles/${id}`)} />
    </RouteGuard>
  );
}

function RoleNewRoute() {
  const { navigate } = useNavigation();
  return (
    <RouteGuard requiredPermissions={["identity:admin"]}>
      <RoleEditorPage onDone={() => navigate("/admin/roles")} />
    </RouteGuard>
  );
}

function RoleEditRoute() {
  const { params, navigate } = useNavigation();
  return (
    <RouteGuard requiredPermissions={["identity:admin"]}>
      <RoleEditorPage roleId={params.roleId} onDone={() => navigate("/admin/roles")} />
    </RouteGuard>
  );
}

function HistoryRoute() {
  return (
    <RouteGuard requiredPermissions={["audit:read"]}>
      <AuditHistoryPage />
    </RouteGuard>
  );
}

export const routes: FeatureRoute[] = [
  { path: "/admin/users", component: UsersRoute, requiredPermissions: ["identity:read"] },
  { path: "/admin/users/:userId", component: UserDetailRoute, requiredPermissions: ["identity:read"] },
  { path: "/admin/roles", component: RolesRoute, requiredPermissions: ["identity:read"] },
  { path: "/admin/roles/new", component: RoleNewRoute, requiredPermissions: ["identity:admin"] },
  { path: "/admin/roles/:roleId", component: RoleEditRoute, requiredPermissions: ["identity:admin"] },
  { path: "/admin/history", component: HistoryRoute, requiredPermissions: ["audit:read"] },
];

export const nav: NavEntry[] = [
  { label: "ユーザー名簿", path: "/admin/users", icon: "users", order: 10, requiredPermissions: ["identity:read"] },
  { label: "ロール管理", path: "/admin/roles", icon: "shield", order: 20, requiredPermissions: ["identity:read"] },
  { label: "変更履歴", path: "/admin/history", icon: "history", order: 30, requiredPermissions: ["audit:read"] },
];

export const adminModule: FeatureModule = { id: "admin", routes, nav };
