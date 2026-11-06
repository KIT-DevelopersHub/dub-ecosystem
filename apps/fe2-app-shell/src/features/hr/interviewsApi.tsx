// 面談の日程調整の api アダプタ + provider + データフック。契約型は @dub/types hrInterview (SoT)。
//   人事アプリ: /api/v1/members/hr/interviews*          → gateway → member-service (閲覧 + hr:read / 編集 + hr:write)
//   公開ページ: /api/v1/public/hr-interview-booking/*   → gateway (PUBLIC) → member-service internal
// 枠の追加・削除と設定の保存は楽観的 UI (先にキャッシュへ反映 → 失敗でスナップショットへ戻してエラートースト)。
// メール送信と予約の取り消しは取り返しがつかない / 応募者のステータスが動くので、結果を待ってから反映する。
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@dub/ui";
import { hrInterview } from "@dub/types";
import type { ApiClient } from "../../lib/api-client.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { HR_LIST_KEY } from "./hrHooks.ts";

type Overview = hrInterview.InterviewOverview;

export interface InterviewsApi {
  overview(): Promise<Overview>;
  addSlot(body: hrInterview.AddInterviewSlotRequest): Promise<Overview>;
  removeSlot(id: string): Promise<Overview>;
  releaseBooking(id: string): Promise<Overview>;
  saveSettings(body: hrInterview.SaveInterviewSettingsRequest): Promise<Overview>;
  sendInvite(id: string): Promise<Overview>;
  viewBooking(token: string): Promise<hrInterview.PublicInterviewBooking>;
  book(body: hrInterview.PublicBookingRequest): Promise<hrInterview.PublicInterviewBooking>;
}

const BASE = "/api/v1/members/hr/interviews";
const PUBLIC = "/api/v1/public/hr-interview-booking";

export function createInterviewsApi(api: ApiClient): InterviewsApi {
  const post = <B,>(path: `/api/v1/${string}`, body?: B) => api.request<Overview, B>({ method: "POST", path, ...(body === undefined ? {} : { body }) });
  return {
    overview: () => api.request<Overview>({ method: "GET", path: BASE }),
    addSlot: (body) => post(`${BASE}/slots`, body),
    removeSlot: (id) => api.request<Overview>({ method: "DELETE", path: `${BASE}/slots/${encodeURIComponent(id)}` }),
    releaseBooking: (id) => post(`${BASE}/slots/${encodeURIComponent(id)}/release`),
    saveSettings: (body) => api.request<Overview, typeof body>({ method: "PUT", path: `${BASE}/settings`, body }),
    sendInvite: (id) => post(`${BASE}/invites/${encodeURIComponent(id)}/send`),
    viewBooking: (token) =>
      api.request<hrInterview.PublicInterviewBooking, hrInterview.PublicBookingViewRequest>({ method: "POST", path: `${PUBLIC}/view`, body: { token } }),
    book: (body) =>
      api.request<hrInterview.PublicInterviewBooking, hrInterview.PublicBookingRequest>({ method: "POST", path: `${PUBLIC}/book`, body }),
  };
}

const Ctx = createContext<InterviewsApi | null>(null);

export function InterviewsProvider({ api, children }: { api: ApiClient; children: ReactNode }): JSX.Element {
  const value = useMemo(() => createInterviewsApi(api), [api]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** テスト用: 直接注入する。 */
export function InterviewsApiProvider({ value, children }: { value: InterviewsApi; children: ReactNode }): JSX.Element {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function useInterviewsApi(): InterviewsApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useInterviewsApi must be used within <InterviewsProvider>");
  return ctx;
}

const OVERVIEW_KEY = queryKeys.feature("hr", "interviews");
const BOOKING_KEY = (token: string) => queryKeys.feature("hr", "interview-booking", token);

const ERROR_MESSAGES: Record<string, string> = {
  HR_SLOT_DUPLICATE: "同じ時間の枠を既に登録しています",
  HR_SLOT_BOOKED: "予約が入っている枠は削除できません。先に予約を取り消してください",
  HR_SLOT_TAKEN: "この日程は埋まりました。別の日程をお選びください",
  HR_BOOKING_CLOSED: "この URL では日程を選べなくなりました",
  HR_INVITE_SEND_FAILED: "メールを送信できませんでした。時間をおいてもう一度お試しください",
};

export function bookingErrorCode(err: unknown): string | null {
  return ApiError.isApiError(err) ? err.code : null;
}

export function interviewErrorMessage(err: unknown, fallback: string): string {
  if (!ApiError.isApiError(err)) return fallback;
  return ERROR_MESSAGES[err.code] ?? toDisplayableError(err).message;
}

export function useInterviewOverview() {
  const api = useInterviewsApi();
  return useQuery({ queryKey: OVERVIEW_KEY, queryFn: () => api.overview(), staleTime: 15_000 });
}

type OverviewCtx = { prev: Overview | undefined };

/** 楽観的な更新の共通形: patch で先に反映し、失敗で戻し、成功でサーバの応答に揃える。 */
function useOptimisticOverview<V>(
  mutationFn: (v: V) => Promise<Overview>,
  patch: (cur: Overview, v: V) => Overview,
  failureMessage: string,
) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<Overview, unknown, V, OverviewCtx>({
    mutationFn,
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: OVERVIEW_KEY, exact: true });
      const prev = qc.getQueryData<Overview>(OVERVIEW_KEY);
      if (prev) qc.setQueryData<Overview>(OVERVIEW_KEY, patch(prev, v));
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(OVERVIEW_KEY, ctx.prev);
      toast.show({ kind: "error", title: interviewErrorMessage(err, failureMessage) });
    },
    onSuccess: (next) => qc.setQueryData(OVERVIEW_KEY, next),
  });
}

export function useAddSlot() {
  const api = useInterviewsApi();
  return useOptimisticOverview<hrInterview.AddInterviewSlotRequest>(
    (body) => api.addSlot(body),
    (cur, { startAt, durationMinutes }) => {
      const slot: hrInterview.InterviewSlot = {
        id: `pending_${startAt}`,
        startAt,
        endAt: new Date(Date.parse(startAt) + durationMinutes * 60_000).toISOString(),
        interviewerId: "",
        interviewerName: "",
        applicantId: null,
        applicantName: null,
        bookedAt: null,
      };
      return { ...cur, slots: [...cur.slots, slot].sort((a, b) => (a.startAt < b.startAt ? -1 : 1)) };
    },
    "枠を追加できませんでした",
  );
}

export function useRemoveSlot() {
  const api = useInterviewsApi();
  return useOptimisticOverview<string>(
    (id) => api.removeSlot(id),
    (cur, id) => ({ ...cur, slots: cur.slots.filter((s) => s.id !== id) }),
    "枠を削除できませんでした",
  );
}

export function useSaveInterviewSettings() {
  const api = useInterviewsApi();
  return useOptimisticOverview<number>(
    (minOpenSlots) => api.saveSettings({ minOpenSlots }),
    (cur, minOpenSlots) => ({ ...cur, settings: { minOpenSlots } }),
    "設定を保存できませんでした",
  );
}

export function useSendInvite() {
  const api = useInterviewsApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<Overview, unknown, string>({
    mutationFn: (id) => api.sendInvite(id),
    onSuccess: (next) => {
      qc.setQueryData(OVERVIEW_KEY, next);
      toast.show({ kind: "success", title: "案内メールを送信しました" });
    },
    onError: (err) => toast.show({ kind: "error", title: interviewErrorMessage(err, "メールを送信できませんでした") }),
  });
}

export function useReleaseBooking() {
  const api = useInterviewsApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<Overview, unknown, string>({
    mutationFn: (id) => api.releaseBooking(id),
    onSuccess: (next) => {
      qc.setQueryData(OVERVIEW_KEY, next);
      void qc.invalidateQueries({ queryKey: HR_LIST_KEY, exact: true });
      toast.show({ kind: "success", title: "予約を取り消しました" });
    },
    onError: (err) => toast.show({ kind: "error", title: interviewErrorMessage(err, "予約を取り消せませんでした") }),
  });
}

export function usePublicBooking(token: string) {
  const api = useInterviewsApi();
  return useQuery({ queryKey: BOOKING_KEY(token), queryFn: () => api.viewBooking(token), retry: false, enabled: token !== "" });
}

export function useBookSlot(token: string) {
  const api = useInterviewsApi();
  const qc = useQueryClient();
  return useMutation<hrInterview.PublicInterviewBooking, unknown, string>({
    mutationFn: (slotId) => api.book({ token, slotId }),
    onSuccess: (next) => qc.setQueryData(BOOKING_KEY(token), next),
    // 枠を取られたら最新の候補を見せ直す。
    onError: () => void qc.invalidateQueries({ queryKey: BOOKING_KEY(token) }),
  });
}
