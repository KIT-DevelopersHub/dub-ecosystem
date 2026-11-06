// 目標管理のデータフック。保存・削除は楽観的 UI (先に一覧へ反映 → 失敗で戻す + エラートースト)。
import { useIsMutating, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useToast } from "@dub/ui";
import { goal } from "@dub/types";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useGoalsApi } from "./GoalsProvider.tsx";

const listKey = (month: string) => queryKeys.feature("goals", "list", month);
const saveKey = (month: string, teamId: string) => queryKeys.feature("goals", "save", month, teamId);

type List = goal.ListGoalsResponse;

function patchGoals(qc: QueryClient, month: string, fn: (goals: goal.TeamGoal[]) => goal.TeamGoal[]): void {
  qc.setQueryData<List>(listKey(month), (prev) => (prev ? { ...prev, goals: fn(prev.goals) } : prev));
}

function messageFor(err: unknown, fallback: string): string {
  if (ApiError.isApiError(err) && err.status === 409) return "他の人が先に更新しました。最新の内容を確認してください";
  return ApiError.isApiError(err) ? toDisplayableError(err).message : fallback;
}

export function useGoals(month: string) {
  const api = useGoalsApi();
  return useQuery({ queryKey: listKey(month), queryFn: () => api.list(month), staleTime: 15_000 });
}

/** 保存直後は、指標を変えた KPI の実績がまだ分からない。手入力と変更なしの分だけ先に見せる。 */
export function optimisticGoal(teamId: string, month: string, body: goal.PutGoalRequest, prev: goal.TeamGoal | undefined): goal.TeamGoal {
  const kpis = body.kpis.map((k): goal.KpiProgress => {
    const known = k.metric === "manual" ? k.manualActual : (prev?.kpis.find((p) => p.metric === k.metric)?.actual ?? null);
    return { ...k, status: known === null ? "empty" : "ok", actual: known, percent: goal.kpiPercent(known, k.target) };
  });
  return {
    teamId, month, title: body.title, kpis, percent: goal.goalPercent(kpis),
    version: body.expectedVersion + 1,
    updatedBy: prev?.updatedBy ?? ("" as goal.TeamGoal["updatedBy"]),
    updatedByName: prev?.updatedByName ?? null,
    updatedAt: prev?.updatedAt ?? new Date().toISOString(),
  };
}

export function useGoalSaving(month: string, teamId: string): boolean {
  return useIsMutating({ mutationKey: saveKey(month, teamId) }) > 0;
}

export function useSaveGoal(month: string, teamId: string) {
  const api = useGoalsApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationKey: saveKey(month, teamId),
    mutationFn: (body: goal.PutGoalRequest) => api.put(teamId, month, body),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: listKey(month) });
      const snapshot = qc.getQueryData<List>(listKey(month));
      const prev = snapshot?.goals.find((g) => g.teamId === teamId);
      const next = optimisticGoal(teamId, month, body, prev);
      patchGoals(qc, month, (goals) => (prev ? goals.map((g) => (g.teamId === teamId ? next : g)) : [...goals, next]));
      return { snapshot };
    },
    onSuccess: (saved) => patchGoals(qc, month, (goals) => [...goals.filter((g) => g.teamId !== teamId), saved]),
    onError: (err, _body, c) => {
      qc.setQueryData(listKey(month), c?.snapshot);
      void qc.invalidateQueries({ queryKey: listKey(month) });
      toast.show({ kind: "error", title: "目標を保存できませんでした", description: messageFor(err, "もう一度お試しください。") });
    },
  });
}

export function useRemoveGoal(month: string, teamId: string) {
  const api = useGoalsApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: () => api.remove(teamId, month),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: listKey(month) });
      const snapshot = qc.getQueryData<List>(listKey(month));
      patchGoals(qc, month, (goals) => goals.filter((g) => g.teamId !== teamId));
      return { snapshot };
    },
    onError: (err, _v, c) => {
      qc.setQueryData(listKey(month), c?.snapshot);
      void qc.invalidateQueries({ queryKey: listKey(month) });
      toast.show({ kind: "error", title: "目標を削除できませんでした", description: messageFor(err, "もう一度お試しください。") });
    },
  });
}
