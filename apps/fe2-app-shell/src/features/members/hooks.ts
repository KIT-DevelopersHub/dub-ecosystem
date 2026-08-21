// Data hooks for 運営メンバー管理: one overview query + optimistic CRUD mutations.
// Edits/adds apply optimistically (先に反映→失敗時ロールバック＋トースト); destructive
// deletes go through a ConfirmDialog in the view and await the server. All keys start
// with the feature id via queryKeys.feature("members", ...).
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useToast } from "@dub/ui";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useMembersApi } from "./MembersProvider.tsx";
import type {
  CreateMemberRequest,
  CreateTeamRequest,
  LinkIdentityRequest,
  MembersOverview,
  OrgMember,
  UpdateMemberRequest,
  UpdateTeamRequest,
} from "./contracts.ts";

export const OVERVIEW_KEY: QueryKey = queryKeys.feature("members", "overview");
export const IDENTITY_USERS_KEY: QueryKey = queryKeys.feature("members", "identity-users");

const EMPTY_OVERVIEW: MembersOverview = { teams: [], members: [] };

export function useMembersOverview() {
  const api = useMembersApi();
  return useQuery({ queryKey: OVERVIEW_KEY, queryFn: () => api.getOverview() });
}

/** Roster login accounts — the candidate pool for linking (#1). Cached a bit longer
 *  than the overview since the account set changes less often than 組織図 edits. */
export function useIdentityUsers() {
  const api = useMembersApi();
  return useQuery({ queryKey: IDENTITY_USERS_KEY, queryFn: () => api.listIdentityUsers(), staleTime: 60_000 });
}

function messageFor(err: unknown, fallback: string): string {
  return ApiError.isApiError(err) ? toDisplayableError(err).message : fallback;
}

/** Generic optimistic overview mutation: snapshot → patch cache → rollback on error. */
function useOverviewMutation<TVars, TData>(config: {
  mutationFn: (vars: TVars) => Promise<TData>;
  optimistic?: (prev: MembersOverview, vars: TVars) => MembersOverview;
  successMessage: string;
  errorFallback: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<TData, unknown, TVars, { prev: MembersOverview | undefined }>({
    mutationFn: config.mutationFn,
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: OVERVIEW_KEY });
      const prev = qc.getQueryData<MembersOverview>(OVERVIEW_KEY);
      if (config.optimistic) {
        qc.setQueryData<MembersOverview>(OVERVIEW_KEY, (old) => config.optimistic!(old ?? EMPTY_OVERVIEW, vars));
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx) qc.setQueryData(OVERVIEW_KEY, ctx.prev);
      toast.show({ kind: "error", title: messageFor(err, config.errorFallback) });
    },
    onSuccess: () => {
      toast.show({ kind: "success", title: config.successMessage });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: OVERVIEW_KEY });
    },
  });
}

// ---- teams ----
export function useCreateTeam() {
  const api = useMembersApi();
  return useOverviewMutation<CreateTeamRequest, unknown>({
    mutationFn: (input) => api.createTeam(input),
    successMessage: "チームを追加しました",
    errorFallback: "チームを追加できませんでした",
  });
}

export function useUpdateTeam() {
  const api = useMembersApi();
  return useOverviewMutation<{ id: string; patch: UpdateTeamRequest }, unknown>({
    mutationFn: ({ id, patch }) => api.updateTeam(id, patch),
    optimistic: (prev, { id, patch }) => ({
      ...prev,
      teams: prev.teams.map((t) => (t.id === id ? { ...t, ...stripUndefined(patch) } : t)),
    }),
    successMessage: "チームを更新しました",
    errorFallback: "チームを更新できませんでした",
  });
}

export function useDeleteTeam() {
  const api = useMembersApi();
  return useOverviewMutation<string, unknown>({
    mutationFn: (id) => api.deleteTeam(id),
    optimistic: (prev, id) => ({
      teams: prev.teams.filter((t) => t.id !== id),
      members: prev.members.map((m) => ({ ...m, teamIds: m.teamIds.filter((t) => t !== id) })),
    }),
    successMessage: "チームを削除しました",
    errorFallback: "チームを削除できませんでした",
  });
}

// ---- members ----
export function useCreateMember() {
  const api = useMembersApi();
  return useOverviewMutation<CreateMemberRequest, unknown>({
    mutationFn: (input) => api.createMember(input),
    successMessage: "メンバーを追加しました",
    errorFallback: "メンバーを追加できませんでした",
  });
}

export function useUpdateMember() {
  const api = useMembersApi();
  return useOverviewMutation<{ id: string; patch: UpdateMemberRequest }, OrgMember>({
    mutationFn: ({ id, patch }) => api.updateMember(id, patch),
    optimistic: (prev, { id, patch }) => ({
      ...prev,
      members: prev.members.map((m) =>
        m.id === id ? { ...m, ...stripUndefined({ ...patch, version: undefined }) } : m,
      ),
    }),
    successMessage: "メンバーを更新しました",
    errorFallback: "メンバーを更新できませんでした",
  });
}

export function useDeleteMember() {
  const api = useMembersApi();
  return useOverviewMutation<string, unknown>({
    mutationFn: (id) => api.deleteMember(id),
    optimistic: (prev, id) => ({ ...prev, members: prev.members.filter((m) => m.id !== id) }),
    successMessage: "メンバーを削除しました",
    errorFallback: "メンバーを削除できませんでした",
  });
}

/** メンバーを追放する = 論理削除(ソフトデリート)。物理削除せず status を "deleted"(削除済み)
 *  にする。楽観的に即「削除済み」表示（組織図からは消える）→失敗でロールバック。
 *  version で楽観ロック（サーバの updateMember を流用）。 */
export function useSoftDeleteMember() {
  const api = useMembersApi();
  return useOverviewMutation<{ id: string; version: number }, OrgMember>({
    mutationFn: ({ id, version }) => api.updateMember(id, { status: "deleted", version }),
    optimistic: (prev, { id }) => ({
      ...prev,
      members: prev.members.map((m) => (m.id === id ? { ...m, status: "deleted", version: m.version + 1 } : m)),
    }),
    successMessage: "メンバーを削除しました（削除済み）",
    errorFallback: "メンバーを削除できませんでした",
  });
}

/** 物理削除(完全削除・不可逆)。名簿から行ごと消す。楽観的に即リストから除去し、失敗時は
 *  ロールバック＋トースト。サーバは status="deleted"(論理削除済み) のみ許可(それ以外 409)。 */
export function useHardDeleteMember() {
  const api = useMembersApi();
  return useOverviewMutation<{ id: string }, unknown>({
    mutationFn: ({ id }) => api.hardDeleteMember(id),
    optimistic: (prev, { id }) => ({ ...prev, members: prev.members.filter((m) => m.id !== id) }),
    successMessage: "メンバーを完全に削除しました",
    errorFallback: "完全に削除できませんでした",
  });
}

/** 削除済みメンバーを在籍(added)へ戻して復帰させる。楽観的に即反映。 */
export function useRestoreMember() {
  const api = useMembersApi();
  return useOverviewMutation<{ id: string; version: number }, OrgMember>({
    mutationFn: ({ id, version }) => api.updateMember(id, { status: "added", version }),
    optimistic: (prev, { id }) => ({
      ...prev,
      members: prev.members.map((m) => (m.id === id ? { ...m, status: "added", version: m.version + 1 } : m)),
    }),
    successMessage: "メンバーを在籍に戻しました",
    errorFallback: "在籍に戻せませんでした",
  });
}

/** Link (or unlink with identityUserId=null) a member to a login account (#1). Optimistic:
 *  the linked account shows immediately, rolling back on error (e.g. 409 already-linked). */
export function useLinkIdentity() {
  const api = useMembersApi();
  return useOverviewMutation<{ id: string; req: LinkIdentityRequest }, OrgMember>({
    mutationFn: ({ id, req }) => api.linkIdentity(id, req),
    optimistic: (prev, { id, req }) => ({
      ...prev,
      members: prev.members.map((m) =>
        m.id === id ? { ...m, identityUserId: req.identityUserId, version: m.version + 1 } : m,
      ),
    }),
    successMessage: "アカウントを紐付けました",
    errorFallback: "アカウントを紐付けできませんでした",
  });
}

export function useUnlinkIdentity() {
  const api = useMembersApi();
  return useOverviewMutation<{ id: string; version: number }, OrgMember>({
    mutationFn: ({ id, version }) => api.updateMember(id, { identityUserId: null, version }),
    optimistic: (prev, { id }) => ({
      ...prev,
      members: prev.members.map((m) => (m.id === id ? { ...m, identityUserId: null, version: m.version + 1 } : m)),
    }),
    successMessage: "紐付けを解除しました",
    errorFallback: "紐付けを解除できませんでした",
  });
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}
