// TanStack Query bindings. Query keys start with "admin" (frozen 1-1-4).
// Optimistic policy (design §2-3): profile edit + role grant apply immediately and
// roll back on error; revoke / permission-bundle save / status change wait for the
// server (called after a ConfirmDialog).
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { identity, common, auditLog, auth } from "@dub/types";
import { isErrorResponse } from "@dub/errors";
import { useRosterContext } from "../providers/RosterProvider";
import { useToast } from "./useToast";
import { queryKeys } from "../lib/queryKeys";
import { type UserListFilters } from "../lib/listUsersQuery";
import { type AuditFilters } from "../lib/auditQuery";
import { type MailStatusResponse } from "../lib/mailStatus";
import { presentError } from "../lib/errorDisplay";
import { applyRoleGrant, makePendingAssignment } from "../lib/optimistic";
import type {
  CreateRoleRequest,
  UpdateRoleRequest,
  AssignRoleRequest,
  RoleAssignment,
  RosterUser,
  SyncEmailRoutingResult,
  EmailRoutingAddress,
  CreateEmailAddressRequest,
  UpdateEmailAddressRequest,
} from "../contracts/pending";

/** The mail-gateway proxy answers 503 with this code when the CF token is unset.
 *  The sync surface reads it to show a "未接続" notice instead of a generic error. */
export const EMAIL_ROUTING_UNCONFIGURED = "MAIL_EMAIL_ROUTING_UNCONFIGURED";
export function isEmailRoutingUnconfigured(err: unknown): boolean {
  return isErrorResponse(err) && err.error.code === EMAIL_ROUTING_UNCONFIGURED;
}

// ---- queries ----
export function useUsers(filters: UserListFilters): UseQueryResult<common.Paginated<RosterUser>> {
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

/** Polling interval for the mail rate-limit status (ms). 45s: fresh enough to clear the
 *  banner soon after recovery, light enough for an always-mounted admin surface. */
export const MAIL_STATUS_POLL_MS = 45_000;

/** Polls the mail-gateway rate-limit status. Errors are swallowed by the caller (banner
 *  is fail-safe: no data => not shown), so a not-yet-wired gateway route never breaks the UI. */
export function useMailRateLimitStatus(): UseQueryResult<MailStatusResponse> {
  const { api } = useRosterContext();
  return useQuery({
    queryKey: queryKeys.mailStatus(),
    queryFn: () => api.mailStatus(),
    refetchInterval: MAIL_STATUS_POLL_MS,
    refetchOnWindowFocus: true,
    staleTime: MAIL_STATUS_POLL_MS / 2,
    retry: false,
  });
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
    // Refresh both the detail cache and the roster list so the inline pane's row
    // (status badge / display name) reflects the saved edit.
    onSettled: () => {
      qc.invalidateQueries({ queryKey: queryKeys.user(userId) });
      qc.invalidateQueries({ queryKey: [queryKeys.root[0], "users", "list"] });
    },
  });
}

/** NON-optimistic: admin sets or re-issues a user's initial password (#5a). Imperative
 *  (triggered by a button); the generated password comes back in `mutation.data.password`
 *  and must be surfaced ONCE by the caller — it is never re-fetchable. */
export function useSetUserPassword(userId: common.UserId) {
  const { api } = useRosterContext();
  return useMutation<auth.AdminSetPasswordResponse, unknown, auth.AdminSetPasswordRequest>({
    mutationFn: (req) => api.setUserPassword(userId, req),
  });
}

/** NON-optimistic: admin views a user's current password (#5c). Imperative + never
 *  cached: the plaintext lives only in `mutation.data` until the caller clears it. */
export function useViewUserPassword(userId: common.UserId) {
  const { api } = useRosterContext();
  return useMutation<auth.AdminViewPasswordResponse, unknown, void>({
    mutationFn: () => api.viewUserPassword(userId),
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

/**
 * Reconcile the roster with Cloudflare Email Routing. Reads the @developershub.jp
 * addresses through the proxy (needs mail:admin), then relays them to identity's
 * synchronous upsert endpoint (needs identity:admin). When the proxy is unconfigured
 * it rejects with EMAIL_ROUTING_UNCONFIGURED — the caller reads `mutation.error`
 * (isEmailRoutingUnconfigured) to render the "未接続" notice instead of a toast.
 */
export function useSyncEmailRouting() {
  const { api } = useRosterContext();
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation<SyncEmailRoutingResult>({
    mutationFn: async () => {
      // Sync from the @developershub.jp RECEIVING addresses (routing rules) — every
      // issued address — NOT the account-scoped destination (forward-target) addresses,
      // of which the domain has ~1 (the old source, which only ever added that one).
      const { items } = await api.listRosterEmailAddresses();
      return api.syncEmailRouting(items);
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: [queryKeys.root[0], "users"] });
      toast({
        kind: "success",
        title: "Email Routing と同期しました",
        description: `追加 ${res.added}・更新 ${res.updated}・停止 ${res.deactivated}`,
      });
    },
    onError: (err) => {
      if (isEmailRoutingUnconfigured(err)) return; // rendered as an inline notice, not a toast
      const p = presentError(err);
      toast({ kind: "error", title: "同期に失敗しました", description: "message" in p ? p.message : undefined });
    },
  });
}

// ---- Email Routing (@developershub.jp address management) ----

export function useEmailAddresses(): UseQueryResult<common.Paginated<EmailRoutingAddress>> {
  const { api } = useRosterContext();
  return useQuery({ queryKey: queryKeys.emailAddresses(), queryFn: () => api.listEmailAddresses() });
}

/** NON-optimistic: issue a new @developershub.jp address (create Email Routing rule). */
export function useCreateEmailAddress() {
  const { api } = useRosterContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateEmailAddressRequest) => api.createEmailAddress(req),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.emailAddresses() }),
  });
}

/** NON-optimistic: enable/disable or re-point an address (patch the rule). */
export function useUpdateEmailAddress() {
  const { api } = useRosterContext();
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (input: { id: string; req: UpdateEmailAddressRequest }) => api.updateEmailAddress(input.id, input.req),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.emailAddresses() }),
    onError: (err) => {
      const p = presentError(err);
      toast({ kind: "error", title: "更新に失敗しました", description: "message" in p ? p.message : undefined });
    },
  });
}

/** NON-optimistic: delete an address (destructive; called after ConfirmDialog). */
export function useDeleteEmailAddress() {
  const { api } = useRosterContext();
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (id: string) => api.deleteEmailAddress(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.emailAddresses() });
      toast({ kind: "success", title: "アドレスを削除しました" });
    },
    onError: (err) => {
      const p = presentError(err);
      toast({ kind: "error", title: "削除に失敗しました", description: "message" in p ? p.message : undefined });
    },
  });
}
