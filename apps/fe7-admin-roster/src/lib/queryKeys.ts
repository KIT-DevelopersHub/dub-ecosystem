// TanStack Query key factory. Every key MUST start with the FeatureModule id
// "admin" (frozen 1-1-4) so FE2 can scope-invalidate the whole feature.
import type { common } from "@dub/types";
import type { UserListFilters } from "./listUsersQuery";
import type { AuditFilters } from "./auditQuery";

export const ADMIN_QK = "admin" as const;

export const queryKeys = {
  root: [ADMIN_QK] as const,
  users: (filters: UserListFilters) => [ADMIN_QK, "users", "list", filters] as const,
  userSummaries: (ids: readonly common.UserId[]) =>
    [ADMIN_QK, "users", "summaries", [...ids].sort()] as const,
  user: (userId: common.UserId) => [ADMIN_QK, "users", "detail", userId] as const,
  userRoles: (userId: common.UserId) => [ADMIN_QK, "users", "roles", userId] as const,
  roles: () => [ADMIN_QK, "roles", "list"] as const,
  role: (roleId: common.RoleId) => [ADMIN_QK, "roles", "detail", roleId] as const,
  permissionCatalog: () => [ADMIN_QK, "permissions", "catalog"] as const,
  audit: (filters: AuditFilters) => [ADMIN_QK, "audit", "list", filters] as const,
  events: () => [ADMIN_QK, "events", "scope-options"] as const,
  mailStatus: () => [ADMIN_QK, "mail", "status"] as const,
  emailAddresses: () => [ADMIN_QK, "email-routing", "list"] as const,
  chatDeletionPolicy: () => [ADMIN_QK, "chat", "deletion-policy"] as const,
} as const;
