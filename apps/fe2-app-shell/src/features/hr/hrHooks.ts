// 人事のデータフック。段階移動とオンボーディングのチェックは楽観的 UI (先にキャッシュへ反映 →
// 失敗でスナップショットへ戻してエラートースト)。名簿を書き換える参加確定と削除は確認ダイアログの
// 後ろで非楽観 (optimistic.tsx の規約: 破壊的操作は楽観にしない)。
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@dub/ui";
import type { hr } from "@dub/types";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useHrApi } from "./HrProvider.tsx";

export const HR_LIST_KEY = queryKeys.feature("hr", "applicants");
export const HR_DETAIL_KEY = (id: string) => queryKeys.feature("hr", "applicant", id);
export const HR_ONBOARDING_KEY = queryKeys.feature("hr", "onboarding");
export const HR_TEAMS_KEY = queryKeys.feature("hr", "teams");
/** 参加確定で名簿が変わるので、運営メンバーの overview も無効化する。 */
const MEMBERS_OVERVIEW_KEY = queryKeys.feature("members", "overview");

function messageFor(err: unknown, fallback: string): string {
  return ApiError.isApiError(err) ? toDisplayableError(err).message : fallback;
}

export function useApplicants() {
  const api = useHrApi();
  return useQuery({ queryKey: HR_LIST_KEY, queryFn: () => api.list(), staleTime: 15_000 });
}

export function useApplicantDetail(id: string | null) {
  const api = useHrApi();
  return useQuery({
    queryKey: HR_DETAIL_KEY(id ?? "none"),
    queryFn: () => api.get(id as string),
    enabled: id !== null,
  });
}

export function useHrTeams() {
  const api = useHrApi();
  return useQuery({ queryKey: HR_TEAMS_KEY, queryFn: () => api.teams(), staleTime: 60_000, retry: false });
}

export function useHrOnboarding() {
  const api = useHrApi();
  return useQuery({ queryKey: HR_ONBOARDING_KEY, queryFn: () => api.onboarding(), staleTime: 15_000 });
}

export function useCreateApplicant() {
  const api = useHrApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<hr.ApplicantDetail, unknown, hr.CreateApplicantRequest>({
    mutationFn: (input) => api.create(input),
    onSuccess: (detail) => {
      qc.setQueryData<hr.ListApplicantsResponse>(HR_LIST_KEY, (prev) =>
        prev ? { applicants: [detail.applicant, ...prev.applicants] } : prev,
      );
      qc.setQueryData(HR_DETAIL_KEY(detail.applicant.id), detail);
      toast.show({ kind: "success", title: `${detail.applicant.name} さんを登録しました` });
    },
    onError: (err) => toast.show({ kind: "error", title: messageFor(err, "応募者を登録できませんでした") }),
  });
}

type ListCtx = { prev: hr.ListApplicantsResponse | undefined };

/** 段階移動 (楽観的)。カンバン/一覧/詳細のどこから動かしても同じ。 */
export function useMoveStage() {
  const api = useHrApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<hr.ApplicantDetail, unknown, { applicant: hr.Applicant; stage: hr.ApplicantStage; note?: string }, ListCtx>({
    mutationFn: ({ applicant, stage, note }) =>
      api.moveStage(applicant.id, { stage, expectedVersion: applicant.version, ...(note ? { note } : {}) }),
    onMutate: async ({ applicant, stage }) => {
      await qc.cancelQueries({ queryKey: HR_LIST_KEY, exact: true });
      const prev = qc.getQueryData<hr.ListApplicantsResponse>(HR_LIST_KEY);
      if (prev) {
        qc.setQueryData<hr.ListApplicantsResponse>(HR_LIST_KEY, {
          applicants: prev.applicants.map((a) => (a.id === applicant.id ? { ...a, stage } : a)),
        });
      }
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(HR_LIST_KEY, ctx.prev);
      toast.show({ kind: "error", title: messageFor(err, "段階を変更できませんでした") });
    },
    onSuccess: (detail) => {
      qc.setQueryData<hr.ListApplicantsResponse>(HR_LIST_KEY, (prev) =>
        prev ? { applicants: prev.applicants.map((a) => (a.id === detail.applicant.id ? detail.applicant : a)) } : prev,
      );
      qc.setQueryData(HR_DETAIL_KEY(detail.applicant.id), detail);
    },
  });
}

export function useAddNote() {
  const api = useHrApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<hr.ApplicantDetail, unknown, { id: string; body: string }>({
    mutationFn: ({ id, body }) => api.addNote(id, { body }),
    onSuccess: (detail) => qc.setQueryData(HR_DETAIL_KEY(detail.applicant.id), detail),
    onError: (err) => toast.show({ kind: "error", title: messageFor(err, "メモを追加できませんでした") }),
  });
}

/** 参加確定 (名簿へ追加)。確認ダイアログの後ろで非楽観。 */
export function useJoinApplicant() {
  const api = useHrApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<hr.JoinApplicantResponse, unknown, { applicant: hr.Applicant; memberId?: string | null }>({
    mutationFn: ({ applicant, memberId }) =>
      api.join(applicant.id, { expectedVersion: applicant.version, ...(memberId ? { memberId } : {}) }),
    onSuccess: (res) => {
      toast.show({ kind: "success", title: `${res.applicant.name} さんを名簿に追加しました` });
      void qc.invalidateQueries({ queryKey: HR_LIST_KEY });
      void qc.invalidateQueries({ queryKey: HR_DETAIL_KEY(res.applicant.id) });
      void qc.invalidateQueries({ queryKey: HR_ONBOARDING_KEY });
      void qc.invalidateQueries({ queryKey: MEMBERS_OVERVIEW_KEY });
    },
    onError: (err) => toast.show({ kind: "error", title: messageFor(err, "参加を確定できませんでした") }),
  });
}

export function useRemoveApplicant() {
  const api = useHrApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<void, unknown, hr.Applicant>({
    mutationFn: (a) => api.remove(a.id),
    onSuccess: (_r, a) => {
      qc.setQueryData<hr.ListApplicantsResponse>(HR_LIST_KEY, (prev) =>
        prev ? { applicants: prev.applicants.filter((x) => x.id !== a.id) } : prev,
      );
      toast.show({ kind: "success", title: `${a.name} さんの応募を削除しました` });
    },
    onError: (err) => toast.show({ kind: "error", title: messageFor(err, "削除できませんでした") }),
  });
}

type ObCtx = { prev: hr.ListOnboardingProgressResponse | undefined };

/** オンボーディング項目のチェック (楽観的)。 */
export function useSetOnboardingCheck() {
  const api = useHrApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<hr.OnboardingProgress, unknown, { memberId: string; itemId: string; checked: boolean }, ObCtx>({
    mutationFn: ({ memberId, itemId, checked }) => api.setCheck(memberId, itemId, checked),
    onMutate: async ({ memberId, itemId, checked }) => {
      await qc.cancelQueries({ queryKey: HR_ONBOARDING_KEY, exact: true });
      const prev = qc.getQueryData<hr.ListOnboardingProgressResponse>(HR_ONBOARDING_KEY);
      if (prev) {
        qc.setQueryData<hr.ListOnboardingProgressResponse>(HR_ONBOARDING_KEY, {
          ...prev,
          members: prev.members.map((m) => {
            if (m.memberId !== memberId) return m;
            const ids = checked
              ? [...new Set([...m.checkedItemIds, itemId])]
              : m.checkedItemIds.filter((x) => x !== itemId);
            return { ...m, checkedItemIds: ids, done: ids.length, completed: m.total > 0 && ids.length === m.total };
          }),
        });
      }
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(HR_ONBOARDING_KEY, ctx.prev);
      toast.show({ kind: "error", title: messageFor(err, "チェックを保存できませんでした") });
    },
    onSuccess: (progress) => {
      qc.setQueryData<hr.ListOnboardingProgressResponse>(HR_ONBOARDING_KEY, (prev) =>
        prev ? { ...prev, members: prev.members.map((m) => (m.memberId === progress.memberId ? progress : m)) } : prev,
      );
    },
  });
}
