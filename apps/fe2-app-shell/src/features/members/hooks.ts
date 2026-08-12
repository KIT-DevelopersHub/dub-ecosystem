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
  MembersOverview,
  OrgMember,
  UpdateMemberRequest,
  UpdateTeamRequest,
} from "./contracts.ts";

export const OVERVIEW_KEY: QueryKey = queryKeys.feature("members", "overview");

const EMPTY_OVERVIEW: MembersOverview = { teams: [], members: [] };

export function useMembersOverview() {
  const api = useMembersApi();
  return useQuery({ queryKey: OVERVIEW_KEY, queryFn: () => api.getOverview() });
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

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}
