// Google アカウント (drive-share-service) の一覧・追加・切り替え・削除。設定は全ロール共通で、
// ロールの「保存」とは独立に即時反映される(サーバー側で切り替わる)。
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useRosterContext } from "../providers/RosterProvider";
import { useToast } from "./useToast";
import { queryKeys } from "../lib/queryKeys";
import { errorMessage } from "../lib/errorDisplay";
import type { DriveGoogleAccountsStatus } from "../contracts/pending";

export function useDriveGoogleAccounts(enabled: boolean): UseQueryResult<DriveGoogleAccountsStatus> {
  const { api } = useRosterContext();
  return useQuery({
    queryKey: queryKeys.driveGoogleAccounts(),
    queryFn: () => api.getDriveGoogleAccounts(),
    enabled,
    // Probes Google on the server; a dialog re-open within a minute reuses the answer.
    staleTime: 60_000,
  });
}

/** Ask the server for Google's consent URL, then leave the SPA for it. */
export function useStartDriveGoogleConnect() {
  const { api } = useRosterContext();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ redirectUri, loginHint }: { redirectUri: string; loginHint?: string }) =>
      api.startDriveGoogleConnect(redirectUri, loginHint),
    onSuccess: ({ authUrl }) => window.location.assign(authUrl),
    onError: (err) => toast({ kind: "error", title: "Google への接続を開始できませんでした", description: errorMessage(err) }),
  });
}

export function useCompleteDriveGoogleConnect() {
  const { api } = useRosterContext();
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ code, state }: { code: string; state: string }) => api.completeDriveGoogleConnect(code, state),
    onSuccess: (status) => {
      qc.setQueryData(queryKeys.driveGoogleAccounts(), status);
      const active = status.accounts.find((a) => a.active);
      toast({ kind: "success", title: "Google アカウントを接続しました", description: active ? `使用中: ${active.email ?? "（不明）"}` : undefined });
    },
  });
}

/** 楽観的に一覧を書き換え、失敗したら元に戻す (切り替え・削除で共通)。 */
function useOptimisticAccounts(opts: {
  mutationFn: (accountId: string) => Promise<DriveGoogleAccountsStatus | void>;
  apply: (cur: DriveGoogleAccountsStatus, accountId: string) => DriveGoogleAccountsStatus;
  success: (email: string) => string;
  failure: string;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const key = queryKeys.driveGoogleAccounts();
  return useMutation({
    mutationFn: opts.mutationFn,
    onMutate: async (accountId: string) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<DriveGoogleAccountsStatus>(key);
      if (prev) qc.setQueryData(key, opts.apply(prev, accountId));
      return { prev };
    },
    onSuccess: (status, accountId, ctx) => {
      if (status) qc.setQueryData(key, status);
      const email = ctx?.prev?.accounts.find((a) => a.id === accountId)?.email ?? "選んだアカウント";
      toast({ kind: "success", title: opts.success(email) });
    },
    onError: (err, _accountId, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast({ kind: "error", title: opts.failure, description: errorMessage(err) });
    },
    // 楽観表示を必ずサーバーの答えで確定させる (削除は本文を返さない・他の管理者の変更も拾う)
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}

export function useSwitchDriveGoogleAccount() {
  const { api } = useRosterContext();
  return useOptimisticAccounts({
    mutationFn: (accountId) => api.switchDriveGoogleAccount(accountId),
    apply: (cur, accountId) => ({ ...cur, accounts: cur.accounts.map((a) => ({ ...a, active: a.id === accountId })) }),
    success: (email) => `${email} に切り替えました`,
    failure: "アカウントを切り替えられませんでした",
  });
}

export function useRemoveDriveGoogleAccount() {
  const { api } = useRosterContext();
  return useOptimisticAccounts({
    mutationFn: (accountId) => api.removeDriveGoogleAccount(accountId),
    apply: (cur, accountId) => ({ ...cur, accounts: cur.accounts.filter((a) => a.id !== accountId) }),
    success: (email) => `${email} を削除しました`,
    failure: "アカウントを削除できませんでした",
  });
}
