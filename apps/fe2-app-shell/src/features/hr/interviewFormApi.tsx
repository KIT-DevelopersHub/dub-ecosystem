// 面談申し込みフォームの api アダプタ + provider + データフック。人事の HrApi とは分けてある
// (応募者の API を太らせない)。契約型は @dub/types hrForm (SoT) をそのまま使う。
//   人事アプリ: /api/v1/members/hr/interview-form*  → gateway → member-service (閲覧 + hr:read / 編集 + hr:write)
//   公開ページ: /api/v1/public/hr-interview-form    → gateway (PUBLIC) → member-service internal
// 書き込みはすべて楽観的 UI (先にキャッシュへ反映 → 失敗でスナップショットへ戻してエラートースト)。
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@dub/ui";
import type { hr, hrForm } from "@dub/types";
import type { ApiClient } from "../../lib/api-client.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { HR_DETAIL_KEY, HR_LIST_KEY } from "./hrHooks.ts";

export interface InterviewFormApi {
  get(): Promise<hrForm.InterviewForm>;
  save(body: hrForm.SaveInterviewFormRequest): Promise<hrForm.InterviewForm>;
  responses(applicantId?: string): Promise<hrForm.ListInterviewFormResponsesResponse>;
  /** 人事による代理入力。 */
  submitOnBehalf(body: hrForm.SubmitInterviewFormRequest): Promise<hrForm.StaffSubmitInterviewFormResponse>;
  /** 公開ページ (未ログイン)。 */
  getPublic(): Promise<hrForm.PublicInterviewForm>;
  submitPublic(body: hrForm.PublicSubmitInterviewFormRequest): Promise<hrForm.PublicSubmitInterviewFormResponse>;
}

const BASE = "/api/v1/members/hr/interview-form";
const PUBLIC = "/api/v1/public/hr-interview-form";

export function createInterviewFormApi(api: ApiClient): InterviewFormApi {
  return {
    get: () => api.request<hrForm.InterviewForm>({ method: "GET", path: BASE }),
    save: (body) => api.request<hrForm.InterviewForm, hrForm.SaveInterviewFormRequest>({ method: "PUT", path: BASE, body }),
    responses: (applicantId) =>
      api.request<hrForm.ListInterviewFormResponsesResponse>({
        method: "GET",
        path: `${BASE}/responses`,
        ...(applicantId ? { query: { applicantId } } : {}),
      }),
    submitOnBehalf: (body) =>
      api.request<hrForm.StaffSubmitInterviewFormResponse, hrForm.SubmitInterviewFormRequest>({
        method: "POST",
        path: `${BASE}/responses`,
        body,
      }),
    getPublic: () => api.request<hrForm.PublicInterviewForm>({ method: "GET", path: PUBLIC }),
    submitPublic: (body) =>
      api.request<hrForm.PublicSubmitInterviewFormResponse, hrForm.PublicSubmitInterviewFormRequest>({
        method: "POST",
        path: PUBLIC,
        body,
      }),
  };
}

const Ctx = createContext<InterviewFormApi | null>(null);

export function InterviewFormProvider({ api, children }: { api: ApiClient; children: ReactNode }): JSX.Element {
  const value = useMemo(() => createInterviewFormApi(api), [api]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** テスト用: 直接注入する。 */
export function InterviewFormApiProvider({ value, children }: { value: InterviewFormApi; children: ReactNode }): JSX.Element {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** provider の外 (旧テストなど) では null。応募者の詳細ドロワーはそのとき回答欄を出さない。 */
export function useOptionalInterviewFormApi(): InterviewFormApi | null {
  return useContext(Ctx);
}

export function useInterviewFormApi(): InterviewFormApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useInterviewFormApi must be used within <InterviewFormProvider>");
  return ctx;
}

/** 申し込みフォーム タブで代理入力を開いた状態にするクエリ (?enter=1)。 */
export const ENTER_ON_BEHALF_PARAM = "enter";

export const FORM_KEY = queryKeys.feature("hr", "interview-form");
export const RESPONSES_KEY = queryKeys.feature("hr", "interview-form-responses");
export const APPLICANT_RESPONSES_KEY = (id: string) => queryKeys.feature("hr", "interview-form-responses", id);
const PUBLIC_FORM_KEY = queryKeys.feature("hr", "interview-form-public");

export function messageFor(err: unknown, fallback: string): string {
  return ApiError.isApiError(err) ? toDisplayableError(err).message : fallback;
}

export function useInterviewForm() {
  const api = useInterviewFormApi();
  return useQuery({ queryKey: FORM_KEY, queryFn: () => api.get(), staleTime: 30_000 });
}

export function useInterviewFormResponses() {
  const api = useInterviewFormApi();
  return useQuery({ queryKey: RESPONSES_KEY, queryFn: () => api.responses(), staleTime: 15_000 });
}

export function useApplicantFormResponses(applicantId: string | null) {
  const api = useOptionalInterviewFormApi();
  return useQuery({
    queryKey: APPLICANT_RESPONSES_KEY(applicantId ?? "none"),
    queryFn: () => (api as InterviewFormApi).responses(applicantId as string),
    enabled: api !== null && applicantId !== null,
  });
}

type FormCtx = { prev: hrForm.InterviewForm | undefined };

/** フォーム定義の保存 (楽観的: 押した瞬間に保存済みの形へ・失敗で戻す)。 */
export function useSaveInterviewForm() {
  const api = useInterviewFormApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<hrForm.InterviewForm, unknown, hrForm.SaveInterviewFormRequest, FormCtx>({
    mutationFn: (body) => api.save(body),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: FORM_KEY, exact: true });
      const prev = qc.getQueryData<hrForm.InterviewForm>(FORM_KEY);
      if (prev) {
        const { expectedVersion: _v, ...rest } = body;
        qc.setQueryData<hrForm.InterviewForm>(FORM_KEY, { ...prev, ...rest, description: rest.description ?? null });
      }
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(FORM_KEY, ctx.prev);
      toast.show({ kind: "error", title: messageFor(err, "フォームを保存できませんでした") });
    },
    onSuccess: (saved) => {
      qc.setQueryData(FORM_KEY, saved);
      toast.show({ kind: "success", title: "フォームを保存しました" });
    },
  });
}

type ListCtx = { prev: hr.ListApplicantsResponse | undefined; tempId: string | null };

/**
 * 代理入力 (楽観的): 送った瞬間に応募者の表へ 面談日程調整中 の仮の行を足す。成功で表と回答一覧を
 * サーバ正に揃え、失敗で仮の行を消してエラートースト。同じメールの選考中の人へ結んだ場合 (deduped) は行を増やさない。
 */
export function useSubmitOnBehalf() {
  const api = useInterviewFormApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<
    hrForm.StaffSubmitInterviewFormResponse,
    unknown,
    { answers: hrForm.FormAnswers; preview: { name: string; email: string | null } },
    ListCtx
  >({
    mutationFn: ({ answers }) => api.submitOnBehalf({ answers }),
    onMutate: async ({ preview }) => {
      await qc.cancelQueries({ queryKey: HR_LIST_KEY, exact: true });
      const prev = qc.getQueryData<hr.ListApplicantsResponse>(HR_LIST_KEY);
      const dupe = prev?.applicants.some(
        (a) => preview.email && a.email?.toLowerCase() === preview.email && ["scheduling", "interview_set", "interviewed"].includes(a.stage),
      );
      const tempId = prev && !dupe ? `pending_${Date.now()}` : null;
      if (prev && tempId) {
        const now = new Date().toISOString();
        qc.setQueryData<hr.ListApplicantsResponse>(HR_LIST_KEY, {
          applicants: [
            {
              id: tempId, name: preview.name, nameKana: null, email: preview.email, department: null, grade: null,
              desiredTeamId: null, source: "面談申し込みフォーム（代理入力）", motivation: null, interviewAt: null,
              stage: "scheduling", memberId: null, participationId: null, version: 0, createdBy: "", createdAt: now,
              updatedAt: now, latestNote: null,
            },
            ...prev.applicants,
          ],
        });
      }
      return { prev, tempId };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(HR_LIST_KEY, ctx.prev);
      toast.show({ kind: "error", title: messageFor(err, "回答を登録できませんでした") });
    },
    onSuccess: (res, vars) => {
      toast.show({
        kind: "success",
        title: res.deduped
          ? `${vars.preview.name} さんは選考中のため、既存の応募者に回答を追加しました`
          : `${vars.preview.name} さんを面談者として登録しました`,
      });
    },
    onSettled: (res) => {
      void qc.invalidateQueries({ queryKey: HR_LIST_KEY });
      void qc.invalidateQueries({ queryKey: RESPONSES_KEY });
      if (res) {
        void qc.invalidateQueries({ queryKey: HR_DETAIL_KEY(res.applicantId) });
        void qc.invalidateQueries({ queryKey: APPLICANT_RESPONSES_KEY(res.applicantId) });
      }
    },
  });
}

export function usePublicInterviewForm() {
  const api = useInterviewFormApi();
  return useQuery({ queryKey: PUBLIC_FORM_KEY, queryFn: () => api.getPublic(), staleTime: 60_000, retry: 1 });
}

export function useSubmitPublicInterviewForm() {
  const api = useInterviewFormApi();
  return useMutation<hrForm.PublicSubmitInterviewFormResponse, unknown, hrForm.PublicSubmitInterviewFormRequest>({
    mutationFn: (body) => api.submitPublic(body),
  });
}
