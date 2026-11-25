// 会計のデータフック。保存は楽観的 UI (先に画面へ反映 → 失敗で戻す + エラートースト)。
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@dub/ui";
import type { accounting } from "@dub/types";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useAccountingApi } from "./AccountingProvider.tsx";

export const ISSUER_KEY = queryKeys.feature("accounting", "issuer");

export function useIssuer() {
  const api = useAccountingApi();
  return useQuery({ queryKey: ISSUER_KEY, queryFn: () => api.getIssuer(), staleTime: 30_000 });
}

/** 保存の楽観値: 入力をそのまま版だけ進めて見せる (更新者・日時は前の値を残し、サーバの返事で置き換える)。 */
export function optimisticIssuer(settings: accounting.IssuerSettings, prev: accounting.AccountingIssuer | null): accounting.AccountingIssuer {
  return {
    ...settings,
    version: (prev?.version ?? 0) + 1,
    updatedBy: prev?.updatedBy ?? ("" as accounting.AccountingIssuer["updatedBy"]),
    updatedByName: prev?.updatedByName ?? null,
    updatedAt: prev?.updatedAt ?? new Date().toISOString(),
  };
}

export function useSaveIssuer() {
  const api = useAccountingApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: accounting.PutIssuerRequest) => api.putIssuer(body),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: ISSUER_KEY });
      const snapshot = qc.getQueryData<accounting.GetIssuerResponse>(ISSUER_KEY);
      const { expectedVersion: _v, ...settings } = body;
      qc.setQueryData<accounting.GetIssuerResponse>(ISSUER_KEY, { issuer: optimisticIssuer(settings, snapshot?.issuer ?? null) });
      return { snapshot };
    },
    onSuccess: (saved) => {
      qc.setQueryData<accounting.GetIssuerResponse>(ISSUER_KEY, { issuer: saved });
      toast.show({ kind: "success", title: "発行者情報を保存しました" });
    },
    onError: (err, _body, c) => {
      qc.setQueryData(ISSUER_KEY, c?.snapshot);
      void qc.invalidateQueries({ queryKey: ISSUER_KEY });
      const message =
        ApiError.isApiError(err) && err.status === 409 ? "他の人が先に更新しました。最新の内容を確認してください"
        : ApiError.isApiError(err) ? toDisplayableError(err).message
        : "もう一度お試しください。";
      toast.show({ kind: "error", title: "発行者情報を保存できませんでした", description: message });
    },
  });
}
