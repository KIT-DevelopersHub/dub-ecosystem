// LP管理 → 流入URL のデータフック。発行・停止/再開は楽観的 UI（先に一覧へ反映 → 失敗時に
// スナップショットへロールバック + エラートースト）。members/hooks.ts と同じ流儀。
//
// queryKey は期間を含む（["lp","links",from,to]）。期間を切り替えると別キャッシュになるので、
// 楽観更新は「いま見ている期間のキャッシュ」だけを触り、他期間は onSettled の invalidate に任せる。
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@dub/ui";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useLpApi } from "./LpProvider.tsx";
import type { CreateLpLinkInput, LpLinkSummary, LpLinksPage, LpLinksQuery } from "./lpApi.tsx";
import { buildTrackingUrl } from "./lpLinks.ts";

/** 同じ期間を見ている間の再取得を抑える（Cloudflare 無料枠の読み取り削減）。 */
const STALE_MS = 60 * 1000;

export function lpLinksKey(range: LpLinksQuery) {
  return queryKeys.feature("lp", "links", range.from, range.to);
}

export function useLpLinks(range: LpLinksQuery) {
  const api = useLpApi();
  return useQuery({
    queryKey: lpLinksKey(range),
    queryFn: () => api.listLinks(range),
    staleTime: STALE_MS,
  });
}

function messageFor(err: unknown, fallback: string): string {
  return ApiError.isApiError(err) ? toDisplayableError(err).message : fallback;
}

/** 楽観挿入用の仮エントリ。id は "optimistic:" 前置で、確定行と見分けられるようにする。 */
function draftLink(input: CreateLpLinkInput): LpLinkSummary {
  return {
    id: `optimistic:${input.slug}`,
    name: input.name,
    slug: input.slug,
    url: buildTrackingUrl(input.slug),
    active: true,
    createdAt: new Date().toISOString(),
    stats: { visits: 0, uniques: 0, lastVisitAt: null },
  };
}

export function useCreateLpLink(range: LpLinksQuery) {
  const api = useLpApi();
  const qc = useQueryClient();
  const toast = useToast();
  const key = lpLinksKey(range);

  return useMutation<LpLinkSummary, unknown, CreateLpLinkInput, { prev: LpLinksPage | undefined }>({
    mutationFn: (input) => api.createLink(input, range),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<LpLinksPage>(key);
      // 新しい行は先頭に積む（発行直後に目に入る位置に出す）。
      qc.setQueryData<LpLinksPage>(key, (old) => ({ items: [draftLink(input), ...(old?.items ?? [])] }));
      return { prev };
    },
    onError: (err, _input, ctx) => {
      if (ctx) qc.setQueryData(key, ctx.prev);
      toast.show({ kind: "error", title: messageFor(err, "流入URLを発行できませんでした") });
    },
    onSuccess: (created) => {
      // 仮 id の行をサーバーの確定行に差し替える（二重行を作らない）。
      qc.setQueryData<LpLinksPage>(key, (old) => ({
        items: [created, ...(old?.items ?? []).filter((l) => l.id !== `optimistic:${created.slug}`)],
      }));
      toast.show({ kind: "success", title: `流入URLを発行しました（${created.name}）` });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.feature("lp", "links") });
    },
  });
}

export function useSetLpLinkActive(range: LpLinksQuery) {
  const api = useLpApi();
  const qc = useQueryClient();
  const toast = useToast();
  const key = lpLinksKey(range);

  return useMutation<LpLinkSummary, unknown, { id: string; active: boolean }, { prev: LpLinksPage | undefined }>({
    mutationFn: (vars) => api.setLinkActive(vars, range),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<LpLinksPage>(key);
      qc.setQueryData<LpLinksPage>(key, (old) => ({
        items: (old?.items ?? []).map((l) => (l.id === vars.id ? { ...l, active: vars.active } : l)),
      }));
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx) qc.setQueryData(key, ctx.prev);
      toast.show({ kind: "error", title: messageFor(err, "状態を変更できませんでした") });
    },
    onSuccess: (updated) => {
      toast.show({ kind: "success", title: updated.active ? "再開しました" : "停止しました" });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.feature("lp", "links") });
    },
  });
}
