// TanStack Query bindings. Query keys start with "admin" (frozen 1-1-4).
// Optimistic policy (design §2-3): profile edit + role grant apply immediately and
// roll back on error; revoke / permission-bundle save / status change wait for the
// server (called after a ConfirmDialog).
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { identity, common, auditLog } from "@dub/types";
import { useRosterContext } from "../providers/RosterProvider";
import { useToast } from "./useToast";
import { queryKeys } from "../lib/queryKeys";
import { type UserListFilters } from "../lib/listUsersQuery";
import { type AuditFilters } from "../lib/auditQuery";
import { presentError } from "../lib/errorDisplay";
import { applyRoleGrant, makePendingAssignment } from "../lib/optimistic";
import type {
  CreateRoleRequest,
  UpdateRoleRequest,
  AssignRoleRequest,
  RoleAssignment,
} from "../contracts/pending";

// ---- queries ----
export function useUsers(filters: UserListFilters): UseQueryResult<common.Paginated<identity.IdentityUser>> {
  const { api } = useRosterContext();
  return useQuery({ queryKey: queryKeys.users(filters), queryFn: () => api.listUsers(filters) });
}

export function useUser(userId: common.UserId): UseQueryResult<identity.IdentityUserDetail> {
  const { api } = useRosterContext();
  return useQuery({ queryKey: queryKeys.user(userId), queryFn: () => api.getUser(userId), enabled: !!userId });
}

export function useUserRoles(userId: common.UserId): UseQueryResult<RoleAssignment[]> {
  const { api } = useRosterContext();
  return useQuery({ queryKey: queryKeys.userRoles(userId), queryFn: () => api.listUserRoles(userId), enabled: !!userId });
}

export function useRoles(): UseQueryResult<common.Paginated<identity.Role>> {
  const { api } = useRosterContext();
  return useQuery({ queryKey: queryKeys.roles(), queryFn: () => api.listRoles() });
}

export function usePermissionCatalog(): UseQueryResult<identity.PermissionCatalogEntry[]> {
  const { api } = useRosterContext();
  return useQuery({ queryKey: queryKeys.permissionCatalog(), queryFn: () => api.permissionCatalog(), staleTime: 5 * 60_000 });
}

export function useAuditLogs(filters: AuditFilters): UseQueryResult<auditLog.AuditLogPage> {
  const { api } = useRosterContext();
  return useQuery({ queryKey: queryKeys.audit(filters), queryFn: () => api.auditLogs(filters) });
}

// ---- mutations ----

/** OPTIMISTIC: profile edit (displayName / githubLogin / status). */
export function usePatchUser(userId: common.UserId) {
  const { api } = useRosterContext();
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (patch: { displayName?: string; status?: identity.UserStatus; githubLogin?: string | null }) =>
      api.patchUser(userId, patch),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: queryKeys.user(userId) });
      const prev = qc.getQueryData<identity.IdentityUserDetail>(queryKeys.user(userId));
      if (prev) qc.setQueryData(queryKeys.user(userId), { ...prev, ...patch });
      return { prev };
    },
    onError: (err, _patch, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKeys.user(userId), ctx.prev);
      const p = presentError(err);
      toast({ kind: "error", title: "更新に失敗しました", description: "message" in p ? p.message : undefined });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.user(userId) }),
  });
}

/** OPTIMISTIC: role grant. Appends a pending assignment, rolls back on error. */
export function useAssignRole(userId: common.UserId, grantedBy: common.UserId) {
  const { api } = useRosterContext();
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (input: { req: AssignRoleRequest; roleName: string }) => api.assignRole(userId, input.req),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: queryKeys.userRoles(userId) });
      const prev = qc.getQueryData<RoleAssignment[]>(queryKeys.userRoles(userId)) ?? [];
      const pending = makePendingAssignment({
        userId, roleId: input.req.roleId, roleName: input.roleName,
        ...(input.req.resourceType ? { resourceType: input.req.resourceType } : {}),
        ...(input.req.resourceId ? { resourceId: input.req.resourceId } : {}),
        grantedBy, now: new Date().toISOString(),
      });
      qc.setQueryData(queryKeys.userRoles(userId), applyRoleGrant(prev, pending));
      return { prev };
    },
    onError: (err, _input, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKeys.userRoles(userId), ctx.prev);
      const p = presentError(err);
      toast({ kind: "error", title: "ロール付与に失敗しました", description: "message" in p ? p.message : undefined });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.userRoles(userId) }),
  });
}

/** NON-optimistic: role revoke (destructive; called after ConfirmDialog). */
export function useRevokeRole(userId: common.UserId) {
  const { api } = useRosterContext();
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (assignmentId: string) => api.revokeRole(userId, assignmentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.userRoles(userId) });
      toast({ kind: "success", title: "ロールを剥奪しました" });
    },
    onError: (err) => {
      const p = presentError(err);
      toast({ kind: "error", title: "剥奪に失敗しました", description: "message" in p ? p.message : undefined });
    },
  });
}

/** NON-optimistic: role create. */
export function useCreateRole() {
  const { api } = useRosterContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateRoleRequest) => api.createRole(req),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.roles() }),
  });
}

/** NON-optimistic: permission-bundle save (design §2-3 destructive line). */
export function useUpdateRole(roleId: common.RoleId) {
  const { api } = useRosterContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: UpdateRoleRequest) => api.updateRole(roleId, req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.roles() });
      qc.invalidateQueries({ queryKey: queryKeys.role(roleId) });
    },
  });
}

/** NON-optimistic: role delete. */
export function useDeleteRole() {
  const { api } = useRosterContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (roleId: common.RoleId) => api.deleteRole(roleId),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.roles() }),
  });
}

/** NON-optimistic: invite. */
export function useInviteUser() {
  const { api } = useRosterContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: identity.InviteUserRequest) => api.inviteUser(req),
    onSuccess: () => qc.invalidateQueries({ queryKey: [queryKeys.root[0], "users"] }),
  });
}
