// 人事のデータフック。ステータス変更・面談日・オンボーディングのチェックは楽観的 UI (先にキャッシュへ
// 反映 → 失敗でスナップショットへ戻してエラートースト)。応募の削除も確認ダイアログの後ろで楽観的
// (FRONTEND_GUIDE 5.3)。名簿を書き換える採用だけは確認ダイアログの後ろで非楽観。
//
// 制御コンポーネント (checkbox / select) は onMutate が走るまでの一瞬だけ古い値に戻って見えるので、
// 画面側は usePendingOverlay (HrShared) で「押した値」を即座に重ねて表示する。
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@dub/ui";
import type { hr, hrResult, meeting } from "@dub/types";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useHrApi } from "./HrProvider.tsx";

export const HR_LIST_KEY = queryKeys.feature("hr", "applicants");
export const HR_DETAIL_KEY = (id: string) => queryKeys.feature("hr", "applicant", id);
export const HR_ONBOARDING_KEY = queryKeys.feature("hr", "onboarding");
export const HR_TEAMS_KEY = queryKeys.feature("hr", "teams");
export const HR_ATTENDANCE_KEY = (from: string, to: string) => queryKeys.feature("hr", "attendance", `${from}_${to}`);
/** interviewFormApi の RESPONSES_KEY と同じ prefix (interviewFormApi → hrHooks の向きの import を保つ)。 */
const HR_FORM_RESPONSES_KEY = queryKeys.feature("hr", "interview-form-responses");
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

/**
 * 応募の削除 (論理削除)。確認ダイアログの後ろで楽観的: 先に一覧から消し、失敗したら元の一覧へ戻して
 * エラートースト。採用〜オンボーディング完了の人はサーバが 409 HR_APPLICANT_JOINED で断る。
 */
export function useRemoveApplicant() {
  const api = useHrApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<void, unknown, hr.Applicant, ListCtx>({
    mutationFn: (a) => api.remove(a.id),
    onMutate: async (a) => {
      await qc.cancelQueries({ queryKey: HR_LIST_KEY, exact: true });
      const prev = qc.getQueryData<hr.ListApplicantsResponse>(HR_LIST_KEY);
      if (prev) {
        qc.setQueryData<hr.ListApplicantsResponse>(HR_LIST_KEY, {
          applicants: prev.applicants.filter((x) => x.id !== a.id),
        });
      }
      return { prev };
    },
    onError: (err, a, ctx) => {
      if (ctx?.prev) qc.setQueryData(HR_LIST_KEY, ctx.prev);
      toast.show({ kind: "error", title: messageFor(err, `${a.name} さんの応募を削除できませんでした`) });
    },
    onSuccess: (_r, a) => {
      qc.removeQueries({ queryKey: HR_DETAIL_KEY(a.id), exact: true });
      // フォーム回答一覧の氏名が「削除済みの応募者」に変わる。
      void qc.invalidateQueries({ queryKey: HR_FORM_RESPONSES_KEY });
      toast.show({ kind: "success", title: `${a.name} さんの応募を削除しました` });
    },
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
type AttVars = { meetingId: string; date: string; userId: string; status: meeting.AttendanceStatus | null };

/** The automatic record of a member (Meet → Dub join), as the server derives it when no manual one exists. */
export function autoRecord(
  base: Pick<meeting.AttendanceRecord, "userId" | "meet" | "joinedAt">,
  durationMinutes: number,
  minPercent: number,
): meeting.AttendanceRecord | null {
  if (base.meet) {
    const present = base.meet.durationSeconds >= Math.ceil((durationMinutes * 60 * minPercent) / 100);
    return { ...base, status: present ? "present" : "absent", source: "meet_api", recordedBy: null, updatedAt: null };
  }
  if (base.joinedAt) return { ...base, status: "present", source: "join", recordedBy: null, updatedAt: null };
  return null;
}

/** Recount every member's rate from the occurrences (same rule as the server). */
function recount(report: meeting.AttendanceReportResponse): meeting.AttendanceReportResponse {
  const members = report.members.map((mem) => {
    let present = 0;
    let excused = 0;
    for (const m of report.meetings) {
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
  return { ...report, members };
}

/** 出席の手修正を report キャッシュに重ねる (null = 手修正を外して自動に戻す)。出席率も数え直す。 */
export function applyAttendance(report: meeting.AttendanceReportResponse, v: AttVars, manual?: meeting.AttendanceRecord | null): meeting.AttendanceReportResponse {
  const meetings = report.meetings.map((m) => {
    if (m.id !== v.meetingId) return m;
    return {
      ...m,
      occurrences: m.occurrences.map((o) => {
        if (o.date !== v.date) return o;
        const cur = o.records.find((r) => r.userId === v.userId);
        const base = { userId: v.userId, meet: cur?.meet ?? null, joinedAt: cur?.joinedAt ?? null };
        const next: meeting.AttendanceRecord | null = v.status
          ? manual ?? { ...base, status: v.status, source: "manual", recordedBy: "", updatedAt: new Date().toISOString() }
          : autoRecord(base, m.durationMinutes, report.settings.minPercent);
        if (next && manual) Object.assign(next, { meet: base.meet, joinedAt: base.joinedAt });
        return { ...o, records: [...o.records.filter((r) => r.userId !== v.userId), ...(next ? [next] : [])] };
      }),
    };
  });
  return recount({ ...report, meetings });
}

/** 未確定の参加者をメンバーに確定したことを report キャッシュに重ねる (その人の他の回も)。 */
export function applyConfirm(report: meeting.AttendanceReportResponse, googleUserId: string, userId: string): meeting.AttendanceReportResponse {
  const meetings = report.meetings.map((m) => ({
    ...m,
    occurrences: m.occurrences.map((o) => {
      const parts = o.participants.map((p) => (p.googleUserId === googleUserId ? { ...p, userId, suggestions: [] } : p));
      const mine = parts.filter((p) => p.userId === userId);
      if (!mine.some((p) => p.googleUserId === googleUserId)) return { ...o, participants: parts };
      const cur = o.records.find((r) => r.userId === userId);
      if (cur?.source === "manual") return { ...o, participants: parts };
      const meet: meeting.MeetPresence = {
        firstJoin: mine.map((p) => p.firstJoin).sort()[0]!,
        lastLeave: mine.some((p) => p.lastLeave === null) ? null : mine.map((p) => p.lastLeave!).sort().at(-1)!,
        durationSeconds: mine.reduce((s, p) => s + p.durationSeconds, 0),
        approx: mine.some((p) => p.approx),
      };
      const rec = autoRecord({ userId, meet, joinedAt: cur?.joinedAt ?? null }, m.durationMinutes, report.settings.minPercent);
      return { ...o, participants: parts, records: [...o.records.filter((r) => r.userId !== userId), ...(rec ? [rec] : [])] };
    }),
  }));
  return recount({ ...report, meetings });
}

/** 出席の手修正 (楽観的: 先に表へ反映 → 失敗で戻してエラートースト)。 */
export function useSetAttendance(range: { from: string; to: string }) {
  const api = useHrApi();
  const qc = useQueryClient();
  const toast = useToast();
  const key = HR_ATTENDANCE_KEY(range.from, range.to);
  return useMutation<meeting.SetAttendanceResponse, unknown, AttVars, AttCtx>({
    mutationFn: (v) => api.setAttendance(v.meetingId, v.date, v.userId, v.status),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: key, exact: true });
      const prev = qc.getQueryData<meeting.AttendanceReportResponse>(key);
      if (prev) qc.setQueryData(key, applyAttendance(prev, v));
      return { prev };
    },
    onSuccess: (res, v) => {
      const cur = qc.getQueryData<meeting.AttendanceReportResponse>(key);
      if (cur && res.record) qc.setQueryData(key, applyAttendance(cur, v, res.record));
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.show({ kind: "error", title: messageFor(err, "出席を変更できませんでした") });
    },
  });
}

/** 未確定の参加者を確定 (楽観的)。確定は記憶され、次回から自動で一致する。 */
export function useConfirmParticipant(range: { from: string; to: string }) {
  const api = useHrApi();
  const qc = useQueryClient();
  const toast = useToast();
  const key = HR_ATTENDANCE_KEY(range.from, range.to);
  return useMutation<{ ok: true }, unknown, { googleUserId: string; userId: string; name: string }, AttCtx>({
    mutationFn: (v) => api.confirmParticipant(v.googleUserId, v.userId),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: key, exact: true });
      const prev = qc.getQueryData<meeting.AttendanceReportResponse>(key);
      if (prev) qc.setQueryData(key, applyConfirm(prev, v.googleUserId, v.userId));
      return { prev };
    },
    onSuccess: (_r, v) => toast.show({ kind: "success", title: `${v.name} さんとして確定しました（次回から自動）` }),
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.show({ kind: "error", title: messageFor(err, "確定できませんでした") });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["hr", "attendance"] }),
  });
}

/** 出席とみなす割合 (楽観的)。率はサーバで数え直すので、反映後に取り直す。 */
export function useAttendanceSettings(range: { from: string; to: string }) {
  const api = useHrApi();
  const qc = useQueryClient();
  const toast = useToast();
  const key = HR_ATTENDANCE_KEY(range.from, range.to);
  return useMutation<meeting.AttendanceSettings, unknown, meeting.AttendanceSettings, AttCtx>({
    mutationFn: (v) => api.updateAttendanceSettings(v),
    onMutate: async (v) => {
      const prev = qc.getQueryData<meeting.AttendanceReportResponse>(key);
      if (prev) qc.setQueryData(key, { ...prev, settings: v });
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.show({ kind: "error", title: messageFor(err, "設定を変更できませんでした") });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["hr", "attendance"] }),
  });
}

/** 「今すぐ取り込む」。 */
export function useIngestAttendance() {
  const api = useHrApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<meeting.IngestAttendanceResponse, unknown, void>({
    mutationFn: () => api.ingestAttendance(),
    onSuccess: (r) => {
      if (r.skipped === "scope_missing") {
        toast.show({ kind: "error", title: "Google アカウントの再連携が必要です（Drive共有 → 設定）" });
        return;
      }
      toast.show({
        kind: "success",
        title: r.complete ? `Meet の記録を取り込みました（${r.occurrences} 回・${r.participants} 人）` : `${r.occurrences} 回分を取り込みました。残りは数分で自動で続きます`,
      });
      void qc.invalidateQueries({ queryKey: ["hr", "attendance"] });
    },
    onError: (err) => toast.show({ kind: "error", title: messageFor(err, "取り込めませんでした") }),
  });
}

/**
 * 面談結果の登録。アカウント発行とメール送信を伴うので確認ダイアログの後ろで非楽観 (成功してから一覧を書き換える)。
 * サーバーが応募者ごとに 1 件に絞るので、二度押しでも発行・送信は 1 回だけ。
 */
export function useRegisterInterviewResult() {
  const api = useHrApi();
  const qc = useQueryClient();
  return useMutation<hrResult.RegisterInterviewResultResponse, unknown, { applicantId: string; body: hrResult.RegisterInterviewResultRequest }>({
    mutationFn: ({ applicantId, body }) => api.registerResult(applicantId, body),
    onSuccess: (res) => {
      qc.setQueryData<hr.ListApplicantsResponse>(HR_LIST_KEY, (prev) =>
        prev ? { applicants: prev.applicants.map((a) => (a.id === res.applicant.id ? { ...a, ...res.applicant } : a)) } : prev,
      );
      void qc.invalidateQueries({ queryKey: HR_DETAIL_KEY(res.applicant.id) });
      void qc.invalidateQueries({ queryKey: HR_ONBOARDING_KEY });
      void qc.invalidateQueries({ queryKey: MEMBERS_OVERVIEW_KEY });
    },
  });
}
