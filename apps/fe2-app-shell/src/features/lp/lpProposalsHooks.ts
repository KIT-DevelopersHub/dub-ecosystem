// LP管理 → 登壇者募集 のデータフック。書き込みはすべて楽観的 UI（先にキャッシュへ反映 → 失敗で
// スナップショットへ戻してエラートースト）。lpTicketsHooks.ts と同じ流儀。
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useToast } from "@dub/ui";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useLpApi } from "./LpProvider.tsx";
import type { LpProposal, LpProposalStatus, LpProposalsPage, LpProposalsState, LpTicketField } from "./lpApi.tsx";

const STALE_MS = 30 * 1000;
export const PROPOSALS_PAGE_SIZE = 25;

export function lpProposalsKey() {
  return queryKeys.feature("lp", "proposals");
}

export function lpProposalSubmissionsKey() {
  return queryKeys.feature("lp", "proposals", "submissions");
}

function messageFor(err: unknown, fallback: string): string {
  return ApiError.isApiError(err) ? toDisplayableError(err).message : fallback;
}

export function useLpProposals() {
  const api = useLpApi();
  return useQuery({ queryKey: lpProposalsKey(), queryFn: () => api.getProposals(), staleTime: STALE_MS });
}

type Ctx = { prev: LpProposalsState | undefined };

export function useSetProposalsEnabled() {
  const api = useLpApi();
  const qc = useQueryClient();
  const toast = useToast();
  const key = lpProposalsKey();
  return useMutation<LpProposalsState, unknown, { enabled: boolean }, Ctx>({
    mutationFn: (vars) => api.setProposalsEnabled(vars),
    onMutate: async ({ enabled }) => {
      await qc.cancelQueries({ queryKey: key, exact: true });
      const prev = qc.getQueryData<LpProposalsState>(key);
      if (prev) qc.setQueryData<LpProposalsState>(key, { ...prev, enabled });
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.show({ kind: "error", title: messageFor(err, "募集状態を切り替えられませんでした") });
    },
    onSuccess: (next) => {
      qc.setQueryData(key, next);
      toast.show({ kind: "success", title: next.enabled ? "登壇者の募集を公開しました" : "登壇者の募集を停止しました" });
    },
  });
}

export function useSaveProposalFields() {
  const api = useLpApi();
  const qc = useQueryClient();
  const toast = useToast();
  const key = lpProposalsKey();
  return useMutation<LpProposalsState, unknown, { fields: LpTicketField[] }, Ctx>({
    mutationFn: (vars) => api.saveProposalFields(vars),
    onMutate: async ({ fields }) => {
      await qc.cancelQueries({ queryKey: key, exact: true });
      const prev = qc.getQueryData<LpProposalsState>(key);
      if (prev) qc.setQueryData<LpProposalsState>(key, { ...prev, fields });
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.show({ kind: "error", title: messageFor(err, "入力項目を保存できませんでした") });
    },
    onSuccess: (next) => {
      qc.setQueryData(key, next);
      toast.show({ kind: "success", title: "入力項目を保存しました" });
    },
  });
}

/** 応募一覧（個人情報なので app:lp:edit のときだけ取りにいく）。 */
export function useLpProposalSubmissions(enabled: boolean) {
  const api = useLpApi();
  return useInfiniteQuery({
    queryKey: lpProposalSubmissionsKey(),
    queryFn: ({ pageParam }) =>
      api.listProposals({ limit: PROPOSALS_PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: STALE_MS,
    enabled,
  });
}

type Pages = InfiniteData<LpProposalsPage, string | null>;

const STATUS_TOAST: Record<LpProposalStatus, string> = {
  submitted: "未対応に戻しました",
  accepted: "採択にしました",
  rejected: "見送りにしました",
};

function countStatus(totals: LpProposalsState["totals"], from: LpProposalStatus, to: LpProposalStatus) {
  const t = { ...totals };
  if (from === "accepted") t.accepted--;
  if (from === "rejected") t.rejected--;
  if (to === "accepted") t.accepted++;
  if (to === "rejected") t.rejected++;
  return t;
}

/** 選考状況の切り替え。一覧の行と上部の件数を先に書き換え、失敗したら両方戻す。 */
export function useSetProposalStatus() {
  const api = useLpApi();
  const qc = useQueryClient();
  const toast = useToast();
  const listKey = lpProposalSubmissionsKey();
  const stateKey = lpProposalsKey();
  return useMutation<
    LpProposal,
    unknown,
    { id: string; status: LpProposalStatus },
    { prevList: Pages | undefined; prevState: LpProposalsState | undefined }
  >({
    mutationFn: ({ id, status }) => api.setProposalStatus(id, { status }),
    onMutate: async ({ id, status }) => {
      await Promise.all([
        qc.cancelQueries({ queryKey: listKey, exact: true }),
        qc.cancelQueries({ queryKey: stateKey, exact: true }),
      ]);
      const prevList = qc.getQueryData<Pages>(listKey);
      const prevState = qc.getQueryData<LpProposalsState>(stateKey);
      const from = prevList?.pages.flatMap((p) => p.items).find((p) => p.id === id)?.status;
      if (prevList) {
        qc.setQueryData<Pages>(listKey, {
          ...prevList,
          pages: prevList.pages.map((p) => ({ ...p, items: p.items.map((x) => (x.id === id ? { ...x, status } : x)) })),
        });
      }
      if (prevState && from && from !== status) {
        qc.setQueryData<LpProposalsState>(stateKey, { ...prevState, totals: countStatus(prevState.totals, from, status) });
      }
      return { prevList, prevState };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prevList) qc.setQueryData(listKey, ctx.prevList);
      if (ctx?.prevState) qc.setQueryData(stateKey, ctx.prevState);
      toast.show({ kind: "error", title: messageFor(err, "選考状況を変更できませんでした") });
    },
    onSuccess: (saved) => {
      qc.setQueryData<Pages>(listKey, (old) =>
        old
          ? { ...old, pages: old.pages.map((p) => ({ ...p, items: p.items.map((x) => (x.id === saved.id ? saved : x)) })) }
          : old,
      );
      toast.show({ kind: "success", title: `「${saved.title}」を${STATUS_TOAST[saved.status]}` });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: stateKey, exact: true });
    },
  });
}
