// LP管理 → スポンサー募集 のデータフック。書き込みは楽観的 UI（先にキャッシュへ反映 → 失敗でスナップショットへ戻して
// エラートースト）。lpProposalsHooks.ts と同じ流儀。
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import type { lpSponsor } from "@dub/types";
import { useToast } from "@dub/ui";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useLpSponsorApi } from "./lpSponsorApi.tsx";

type State = lpSponsor.LpSponsorInquiriesState;
type Page = lpSponsor.LpSponsorInquiriesPage;
type Status = lpSponsor.LpSponsorInquiryStatus;

const STALE_MS = 30 * 1000;
export const SPONSOR_PAGE_SIZE = 25;

export const lpSponsorKey = () => queryKeys.feature("lp", "sponsor-inquiries");
export const lpSponsorItemsKey = () => queryKeys.feature("lp", "sponsor-inquiries", "items");

function messageFor(err: unknown, fallback: string): string {
  return ApiError.isApiError(err) ? toDisplayableError(err).message : fallback;
}

export function useLpSponsor() {
  const api = useLpSponsorApi();
  return useQuery({ queryKey: lpSponsorKey(), queryFn: () => api.get(), staleTime: STALE_MS });
}

/** 公開/停止・通知先の保存。どちらも状態全体を返すので同じ形で楽観更新する。 */
function useStateMutation<V>(
  fn: (vars: V) => Promise<State>,
  apply: (prev: State, vars: V) => State,
  messages: { error: string; success: (next: State) => string },
) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = lpSponsorKey();
  return useMutation<State, unknown, V, { prev: State | undefined }>({
    mutationFn: fn,
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: key, exact: true });
      const prev = qc.getQueryData<State>(key);
      if (prev) qc.setQueryData<State>(key, apply(prev, vars));
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.show({ kind: "error", title: messageFor(err, messages.error) });
    },
    onSuccess: (next) => {
      qc.setQueryData(key, next);
      toast.show({ kind: "success", title: messages.success(next) });
    },
  });
}

export function useSetSponsorEnabled() {
  const api = useLpSponsorApi();
  return useStateMutation<{ enabled: boolean }>(
    (v) => api.setEnabled(v),
    (prev, { enabled }) => ({ ...prev, enabled }),
    {
      error: "公開状態を切り替えられませんでした",
      success: (n) => (n.enabled ? "スポンサー募集を公開しました" : "スポンサー募集を停止しました"),
    },
  );
}

export function useSetSponsorNotify() {
  const api = useLpSponsorApi();
  return useStateMutation<lpSponsor.LpSponsorNotifyInput>(
    (v) => api.setNotify(v),
    (prev, v) => ({ ...prev, ...v }),
    { error: "通知先を保存できませんでした", success: () => "通知先を保存しました" },
  );
}

/** 資料請求の一覧（個人情報なので app:lp:edit のときだけ取りにいく）。 */
export function useLpSponsorItems(enabled: boolean) {
  const api = useLpSponsorApi();
  return useInfiniteQuery({
    queryKey: lpSponsorItemsKey(),
    queryFn: ({ pageParam }) =>
      api.list({ limit: SPONSOR_PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: STALE_MS,
    enabled,
  });
}

type Pages = InfiniteData<Page, string | null>;

/** 対応状況の切り替え。一覧の行を先に書き換え、失敗したら戻す。件数は成功後に読み直す。 */
export function useSetSponsorInquiryStatus() {
  const api = useLpSponsorApi();
  const qc = useQueryClient();
  const toast = useToast();
  const listKey = lpSponsorItemsKey();
  return useMutation<lpSponsor.LpSponsorInquiry, unknown, { id: string; status: Status }, { prev: Pages | undefined }>({
    mutationFn: ({ id, status }) => api.setStatus(id, { status }),
    onMutate: async ({ id, status }) => {
      await qc.cancelQueries({ queryKey: listKey, exact: true });
      const prev = qc.getQueryData<Pages>(listKey);
      if (prev) {
        qc.setQueryData<Pages>(listKey, {
          ...prev,
          pages: prev.pages.map((p) => ({ ...p, items: p.items.map((x) => (x.id === id ? { ...x, status } : x)) })),
        });
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(listKey, ctx.prev);
      toast.show({ kind: "error", title: messageFor(err, "対応状況を変更できませんでした") });
    },
    onSuccess: () => toast.show({ kind: "success", title: "対応状況を変更しました" }),
    onSettled: () => void qc.invalidateQueries({ queryKey: lpSponsorKey(), exact: true }),
  });
}
