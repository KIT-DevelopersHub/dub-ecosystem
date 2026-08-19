// TanStack Query bindings. Query keys start with "admin" (frozen 1-1-4).
// Optimistic policy (design §2-3): profile edit + role grant apply immediately and
// roll back on error; revoke / permission-bundle save / status change wait for the
// server (called after a ConfirmDialog).
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { identity, common, auditLog, auth, chat, member } from "@dub/types";
import { isErrorResponse } from "@dub/errors";
import { useRosterContext } from "../providers/RosterProvider";
import { useToast } from "./useToast";
import { queryKeys } from "../lib/queryKeys";
import { type UserListFilters } from "../lib/listUsersQuery";
import { type AuditFilters } from "../lib/auditQuery";
import { type MailStatusResponse } from "../lib/mailStatus";
import { presentError } from "../lib/errorDisplay";
import { applyRoleGrant, makePendingAssignment, addUserRoleId, removeUserRoleId } from "../lib/optimistic";
import { runOffboard } from "../lib/offboard";
import type {
  CreateRoleRequest,
  UpdateRoleRequest,
  AssignRoleRequest,
  RoleAssignment,
  RosterUser,
  SyncEmailRoutingResult,
  EmailRoutingSyncPreview,
  CreateEmailAddressRequest,
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

/** Partial key matching EVERY cached roster list query (all filter/cursor variants),
 *  so an inline role edit reflects in the ロール column regardless of active filters. */
const USERS_LIST_KEY = [queryKeys.root[0], "users", "list"] as const;

/** OPTIMISTIC inline (roster list): grant an ORG-WIDE role straight from the ロール
 *  column. Reuses the audited assign endpoint but reflects the change instantly in the
 *  list's `roleIds` (and the per-user roles cache), rolling back on error. */
export function useAssignRoleInline(userId: common.UserId, grantedBy: common.UserId) {
  const { api } = useRosterContext();
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (input: { roleId: common.RoleId; roleName: string }) =>
      api.assignRole(userId, { roleId: input.roleId }),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: USERS_LIST_KEY });
      await qc.cancelQueries({ queryKey: queryKeys.userRoles(userId) });
      const prevLists = qc.getQueriesData<common.Paginated<RosterUser>>({ queryKey: USERS_LIST_KEY });
      const prevRoles = qc.getQueryData<RoleAssignment[]>(queryKeys.userRoles(userId)) ?? [];
      qc.setQueriesData<common.Paginated<RosterUser>>({ queryKey: USERS_LIST_KEY }, (page) =>
        addUserRoleId(page, userId, input.roleId),
      );
      const pending = makePendingAssignment({
        userId, roleId: input.roleId, roleName: input.roleName,
        grantedBy, now: new Date().toISOString(),
      });
      qc.setQueryData(queryKeys.userRoles(userId), applyRoleGrant(prevRoles, pending));
      return { prevLists, prevRoles };
    },
    onError: (err, _input, ctx) => {
      ctx?.prevLists?.forEach(([key, data]) => qc.setQueryData(key, data));
      if (ctx) qc.setQueryData(queryKeys.userRoles(userId), ctx.prevRoles);
      const p = presentError(err);
      toast({ kind: "error", title: "ロール付与に失敗しました", description: "message" in p ? p.message : undefined });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: USERS_LIST_KEY });
      qc.invalidateQueries({ queryKey: queryKeys.userRoles(userId) });
    },
  });
}

/** OPTIMISTIC inline (roster list): revoke an ORG-WIDE role straight from the ロール
 *  column. The caller resolves the assignment id (from the per-user roles cache); the
 *  server still enforces the last-admin guard and rejects with a rollback + toast. */
export function useRevokeRoleInline(userId: common.UserId) {
  const { api } = useRosterContext();
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (input: { assignmentId: string; roleId: common.RoleId }) =>
      api.revokeRole(userId, input.assignmentId),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: USERS_LIST_KEY });
      await qc.cancelQueries({ queryKey: queryKeys.userRoles(userId) });
      const prevLists = qc.getQueriesData<common.Paginated<RosterUser>>({ queryKey: USERS_LIST_KEY });
      const prevRoles = qc.getQueryData<RoleAssignment[]>(queryKeys.userRoles(userId)) ?? [];
      qc.setQueriesData<common.Paginated<RosterUser>>({ queryKey: USERS_LIST_KEY }, (page) =>
        removeUserRoleId(page, userId, input.roleId),
      );
      qc.setQueryData(
        queryKeys.userRoles(userId),
        prevRoles.filter((a) => a.id !== input.assignmentId),
      );
      return { prevLists, prevRoles };
    },
    onError: (err, _input, ctx) => {
      ctx?.prevLists?.forEach(([key, data]) => qc.setQueryData(key, data));
      if (ctx) qc.setQueryData(queryKeys.userRoles(userId), ctx.prevRoles);
      const p = presentError(err);
      toast({ kind: "error", title: "剥奪に失敗しました", description: "message" in p ? p.message : undefined });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: USERS_LIST_KEY });
      qc.invalidateQueries({ queryKey: queryKeys.userRoles(userId) });
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

/** #2: one-shot退任 (offboard). Runs the identity one-shot + member在籍更新 + Email
 *  Routing削除, then refreshes the affected caches. Returns the per-step OffboardOutcome
 *  so the caller can render partial success. NON-optimistic (destructive, after confirm). */
export function useOffboardUser() {
  const { api } = useRosterContext();
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (user: { id: common.UserId; email: string }) => runOffboard(api, user),
    onSuccess: (outcome) => {
      qc.invalidateQueries({ queryKey: [queryKeys.root[0], "users"] });
      qc.invalidateQueries({ queryKey: queryKeys.user(outcome.identity!.user.id) });
      qc.invalidateQueries({ queryKey: queryKeys.userRoles(outcome.identity!.user.id) });
      qc.invalidateQueries({ queryKey: queryKeys.emailAddresses() });
      toast(
        outcome.ok
          ? { kind: "success", title: "オフボードが完了しました" }
          : { kind: "error", title: "一部の処理が失敗しました", description: "詳細を確認してください" },
      );
    },
    onError: (err) => {
      const p = presentError(err);
      toast({ kind: "error", title: "オフボードに失敗しました", description: "message" in p ? p.message : undefined });
    },
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
/**
 * #5: PREVIEW the Email Routing sync. Reads the @developershub.jp addresses through the
 * proxy (needs mail:admin), then asks identity for the read-only diff (needs
 * identity:admin) WITHOUT applying it. Surfaces EMAIL_ROUTING_UNCONFIGURED the same way
 * as the apply, so the caller reuses isEmailRoutingUnconfigured for the "未接続" notice.
 */
export function usePreviewEmailRouting() {
  const { api } = useRosterContext();
  const { toast } = useToast();
  return useMutation<EmailRoutingSyncPreview>({
    mutationFn: async () => {
      const { items } = await api.listRosterEmailAddresses();
      return api.previewEmailRouting(items);
    },
    onError: (err) => {
      if (isEmailRoutingUnconfigured(err)) return; // inline notice, not a toast
      const p = presentError(err);
      toast({ kind: "error", title: "プレビューの取得に失敗しました", description: "message" in p ? p.message : undefined });
    },
  });
}

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

// ---- Email Routing (@developershub.jp address issuance, used by the roster) ----

/** NON-optimistic: issue a new @developershub.jp address (create Email Routing rule).
 *  Used by the roster's NewEmailAddressDialog (name-book), which re-syncs after issue. */
export function useCreateEmailAddress() {
  const { api } = useRosterContext();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateEmailAddressRequest) => api.createEmailAddress(req),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.emailAddresses() }),
  });
}

// ---- 運営メンバー紐付け (メール名簿 ↔ 運営メンバー) --------------------------------
// The メール名簿 (identity_users) side links each @developershub.jp account to an existing
// 運営メンバー — the REVERSE direction of fe2's member→account LinkIdentityDialog. Both write
// the SAME `member.identityUserId` bridge (single source of truth); the server enforces the
// 1:1 constraint (MEMBER_IDENTITY_ALREADY_LINKED 409). Optimistic per [[optimistic-ui-principle]].

/** 運営メンバー一覧 (member-service overview). Read to show which member each email row is
 *  linked to, and to power the「運営メンバーと紐付け」picker. Needs identity:read (gateway). */
export function useMembersOverview(): UseQueryResult<member.MembersOverview> {
  const { api } = useRosterContext();
  return useQuery({ queryKey: queryKeys.membersOverview(), queryFn: () => api.listMembersOverview(), staleTime: 60_000 });
}

/** Patch the members-overview cache so a link/unlink reflects instantly (shared helper). */
function setMemberIdentityInCache(
  qc: ReturnType<typeof useQueryClient>,
  memberId: string,
  identityUserId: string | null,
): member.MembersOverview | undefined {
  const key = queryKeys.membersOverview();
  const prev = qc.getQueryData<member.MembersOverview>(key);
  if (prev) {
    qc.setQueryData<member.MembersOverview>(key, {
      ...prev,
      members: prev.members.map((m) =>
        m.id === memberId ? { ...m, identityUserId, version: m.version + 1 } : m,
      ),
    });
  }
  return prev;
}

/** OPTIMISTIC: link an 運営メンバー to a developershub.jp/identity account (メール名簿側)。 */
export function useLinkMemberIdentity() {
  const { api } = useRosterContext();
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation<member.Member, unknown, { member: member.Member; identityUserId: common.UserId }, { prev: member.MembersOverview | undefined }>({
    mutationFn: ({ member: m, identityUserId }) =>
      api.linkMemberIdentity(m.id, { identityUserId, version: m.version }),
    onMutate: async ({ member: m, identityUserId }) => {
      await qc.cancelQueries({ queryKey: queryKeys.membersOverview() });
      const prev = setMemberIdentityInCache(qc, m.id, identityUserId);
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKeys.membersOverview(), ctx.prev);
      const p = presentError(err);
      toast({ kind: "error", title: "運営メンバーと紐付けできませんでした", description: "message" in p ? p.message : undefined });
    },
    onSuccess: () => toast({ kind: "success", title: "運営メンバーと紐付けました" }),
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.membersOverview() }),
  });
}

/** OPTIMISTIC: unlink an 運営メンバー from its account (メール名簿側)。identityUserId=null via PATCH. */
export function useUnlinkMemberIdentity() {
  const { api } = useRosterContext();
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation<member.Member, unknown, { member: member.Member }, { prev: member.MembersOverview | undefined }>({
    mutationFn: ({ member: m }) => api.patchMember(m.id, { identityUserId: null, version: m.version }),
    onMutate: async ({ member: m }) => {
      await qc.cancelQueries({ queryKey: queryKeys.membersOverview() });
      const prev = setMemberIdentityInCache(qc, m.id, null);
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKeys.membersOverview(), ctx.prev);
      const p = presentError(err);
      toast({ kind: "error", title: "紐付けを解除できませんでした", description: "message" in p ? p.message : undefined });
    },
    onSuccess: () => toast({ kind: "success", title: "紐付けを解除しました" }),
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.membersOverview() }),
  });
}

// ---- チャット: メッセージ削除ポリシー (RBAC-configurable delete behaviour) ----

/** The workspace chat message-deletion policy (per privilege tier). Any authenticated
 *  admin may read it; the section stays read-only unless can("chat:moderate"). */
export function useChatDeletionPolicy(): UseQueryResult<chat.DeletionPolicyResponse> {
  const { api } = useRosterContext();
  return useQuery({
    queryKey: queryKeys.chatDeletionPolicy(),
    queryFn: () => api.getChatDeletionPolicy(),
    staleTime: 60_000,
  });
}

/** NON-optimistic: save the deletion policy (ConfirmDialog upstream). Version-locked —
 *  the server 409s on a stale `version`; the caller re-reads and retries. */
export function useUpdateChatDeletionPolicy() {
  const { api } = useRosterContext();
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (req: chat.UpdateDeletionPolicyRequest) => api.updateChatDeletionPolicy(req),
    onSuccess: (res) => {
      qc.setQueryData(queryKeys.chatDeletionPolicy(), res);
      toast({ kind: "success", title: "メッセージ削除ポリシーを保存しました" });
    },
    onError: (err) => {
      const p = presentError(err);
      toast({ kind: "error", title: "保存に失敗しました", description: "message" in p ? p.message : undefined });
    },
  });
}
