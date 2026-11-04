// 人事のデータフック。ステータス変更・面談日・オンボーディングのチェックは楽観的 UI (先にキャッシュへ
// 反映 → 失敗でスナップショットへ戻してエラートースト)。名簿を書き換える採用と削除は確認ダイアログの
// 後ろで非楽観 (optimistic.tsx の規約: 破壊的操作は楽観にしない)。
//
// 制御コンポーネント (checkbox / select) は onMutate が走るまでの一瞬だけ古い値に戻って見えるので、
// 画面側は usePendingOverlay (HrShared) で「押した値」を即座に重ねて表示する。
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@dub/ui";
import type { hr, meeting } from "@dub/types";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useHrApi } from "./HrProvider.tsx";

export const HR_LIST_KEY = queryKeys.feature("hr", "applicants");
export const HR_DETAIL_KEY = (id: string) => queryKeys.feature("hr", "applicant", id);
export const HR_ONBOARDING_KEY = queryKeys.feature("hr", "onboarding");
export const HR_TEAMS_KEY = queryKeys.feature("hr", "teams");
export const HR_ATTENDANCE_KEY = (from: string, to: string) => queryKeys.feature("hr", "attendance", `${from}_${to}`);
/** 採用で名簿が変わるので、運営メンバーの overview も無効化する。 */
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
        prev ? { applicants: [{ ...detail.applicant, latestNote: null }, ...prev.applicants] } : prev,
      );
      qc.setQueryData(HR_DETAIL_KEY(detail.applicant.id), detail);
      toast.show({ kind: "success", title: `${detail.applicant.name} さんを登録しました` });
    },
    onError: (err) => toast.show({ kind: "error", title: messageFor(err, "応募者を登録できませんでした") }),
  });
}

type ListCtx = { prev: hr.ListApplicantsResponse | undefined };

/** ステータス変更 (楽観的)。表のプルダウンからも詳細ドロワーからも同じ。 */
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
      toast.show({ kind: "error", title: messageFor(err, "ステータスを変更できませんでした") });
    },
    onSuccess: (detail) => {
      qc.setQueryData<hr.ListApplicantsResponse>(HR_LIST_KEY, (prev) =>
        prev ? { applicants: prev.applicants.map((a) => (a.id === detail.applicant.id ? { ...a, ...detail.applicant } : a)) } : prev,
      );
      qc.setQueryData(HR_DETAIL_KEY(detail.applicant.id), detail);
      // 採用系に動いたらオンボーディング一覧の対象が変わる。
      void qc.invalidateQueries({ queryKey: HR_ONBOARDING_KEY });
    },
  });
}

/** 面談日などの項目更新 (楽観的)。 */
export function useUpdateApplicant() {
  const api = useHrApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<hr.Applicant, unknown, { applicant: hr.Applicant; patch: Omit<hr.UpdateApplicantRequest, "expectedVersion"> }, ListCtx>({
    mutationFn: ({ applicant, patch }) => api.update(applicant.id, { ...patch, expectedVersion: applicant.version }),
    onMutate: async ({ applicant, patch }) => {
      await qc.cancelQueries({ queryKey: HR_LIST_KEY, exact: true });
      const prev = qc.getQueryData<hr.ListApplicantsResponse>(HR_LIST_KEY);
      if (prev) {
        qc.setQueryData<hr.ListApplicantsResponse>(HR_LIST_KEY, {
          applicants: prev.applicants.map((a) => (a.id === applicant.id ? { ...a, ...patch } as hr.ApplicantListItem : a)),
        });
      }
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(HR_LIST_KEY, ctx.prev);
      toast.show({ kind: "error", title: messageFor(err, "保存できませんでした") });
    },
    onSuccess: (next) => {
      qc.setQueryData<hr.ListApplicantsResponse>(HR_LIST_KEY, (prev) =>
        prev ? { applicants: prev.applicants.map((a) => (a.id === next.id ? { ...a, ...next } : a)) } : prev,
      );
      void qc.invalidateQueries({ queryKey: HR_DETAIL_KEY(next.id) });
    },
  });
}

export function useAddNote() {
  const api = useHrApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<hr.ApplicantDetail, unknown, { id: string; body: string }>({
    mutationFn: ({ id, body }) => api.addNote(id, { body }),
    onSuccess: (detail, vars) => {
      qc.setQueryData(HR_DETAIL_KEY(detail.applicant.id), detail);
      qc.setQueryData<hr.ListApplicantsResponse>(HR_LIST_KEY, (prev) =>
        prev ? { applicants: prev.applicants.map((a) => (a.id === vars.id ? { ...a, latestNote: vars.body.trim() } : a)) } : prev,
      );
    },
    onError: (err) => toast.show({ kind: "error", title: messageFor(err, "メモを追加できませんでした") }),
  });
}

/** 採用 (名簿へ追加)。確認ダイアログの後ろで非楽観。 */
export function useJoinApplicant() {
  const api = useHrApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<hr.JoinApplicantResponse, unknown, { applicant: hr.Applicant; memberId?: string | null }>({
    mutationFn: ({ applicant, memberId }) =>
      api.join(applicant.id, { expectedVersion: applicant.version, ...(memberId ? { memberId } : {}) }),
    onSuccess: (res) => {
      toast.show({ kind: "success", title: `${res.applicant.name} さんを採用し、名簿に追加しました` });
      void qc.invalidateQueries({ queryKey: HR_LIST_KEY });
      void qc.invalidateQueries({ queryKey: HR_DETAIL_KEY(res.applicant.id) });
      void qc.invalidateQueries({ queryKey: HR_ONBOARDING_KEY });
      void qc.invalidateQueries({ queryKey: MEMBERS_OVERVIEW_KEY });
    },
    onError: (err) => toast.show({ kind: "error", title: messageFor(err, "採用できませんでした") }),
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
            const completed = m.total > 0 && ids.length === m.total;
            const stage: hr.ApplicantStage | null = completed ? "onboarded" : ids.length > 0 ? "onboarding" : m.stage;
            return { ...m, checkedItemIds: ids, done: ids.length, completed, stage };
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
      // チェックでステータスが自動で進む/戻るので一覧も揃える。
      if (progress.applicantId && progress.stage) {
        qc.setQueryData<hr.ListApplicantsResponse>(HR_LIST_KEY, (prev) =>
          prev ? { applicants: prev.applicants.map((a) => (a.id === progress.applicantId ? { ...a, stage: progress.stage! } : a)) } : prev,
        );
        void qc.invalidateQueries({ queryKey: HR_LIST_KEY });
        void qc.invalidateQueries({ queryKey: HR_DETAIL_KEY(progress.applicantId) });
      }
    },
  });
}

export function useHrAttendance(range: { from: string; to: string }) {
  const api = useHrApi();
  return useQuery({ queryKey: HR_ATTENDANCE_KEY(range.from, range.to), queryFn: () => api.attendance(range), staleTime: 15_000 });
}

type AttCtx = { prev: meeting.AttendanceReportResponse | undefined };

/** 出席の手修正を report キャッシュに重ねる (出席率もその場で再計算)。 */
export function applyAttendance(
  report: meeting.AttendanceReportResponse,
  v: { meetingId: string; date: string; userId: string; status: meeting.AttendanceStatus | null },
  record: meeting.AttendanceRecord | null,
): meeting.AttendanceReportResponse {
  const meetings = report.meetings.map((m) =>
    m.id !== v.meetingId
      ? m
      : {
          ...m,
          occurrences: m.occurrences.map((o) =>
            o.date !== v.date ? o : { ...o, records: [...o.records.filter((r) => r.userId !== v.userId), ...(record ? [record] : [])] },
          ),
        },
  );
  const members = report.members.map((mem) => {
    let present = 0;
    let excused = 0;
    for (const m of meetings) {
      if (!m.expectedUserIds.includes(mem.userId)) continue;
      for (const o of m.occurrences) {
        const r = o.records.find((x) => x.userId === mem.userId);
        if (r?.status === "present") present++;
        else if (r?.status === "excused") excused++;
      }
    }
    const denom = mem.expected - excused;
    return { ...mem, present, excused, rate: denom > 0 ? present / denom : null };
  });
  return { ...report, meetings, members };
}

/** 出席の手修正 (楽観的: 先に表へ反映 → 失敗で戻してエラートースト)。 */
export function useSetAttendance(range: { from: string; to: string }) {
  const api = useHrApi();
  const qc = useQueryClient();
  const toast = useToast();
  const key = HR_ATTENDANCE_KEY(range.from, range.to);
  return useMutation<meeting.SetAttendanceResponse, unknown, { meetingId: string; date: string; userId: string; status: meeting.AttendanceStatus | null }, AttCtx>({
    mutationFn: (v) => api.setAttendance(v.meetingId, v.date, v.userId, v.status),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: key, exact: true });
      const prev = qc.getQueryData<meeting.AttendanceReportResponse>(key);
      if (prev) {
        const optimistic: meeting.AttendanceRecord | null = v.status
          ? { userId: v.userId, status: v.status, source: "manual", joinedAt: null, recordedBy: "", updatedAt: new Date().toISOString() }
          : null;
        qc.setQueryData(key, applyAttendance(prev, v, optimistic));
      }
      return { prev };
    },
    onSuccess: (res, v) => {
      const cur = qc.getQueryData<meeting.AttendanceReportResponse>(key);
      if (cur) qc.setQueryData(key, applyAttendance(cur, v, res.record));
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.show({ kind: "error", title: messageFor(err, "出席を変更できませんでした") });
    },
  });
}
