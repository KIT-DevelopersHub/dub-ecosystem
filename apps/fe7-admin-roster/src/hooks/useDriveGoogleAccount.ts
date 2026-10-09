// Drive共有 の Google アカウント (drive-share-service) の取得・接続。設定は全ロール共通で、
// ロールの「保存」とは独立に即時反映される(接続 = サーバー側で切り替わる)。
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useRosterContext } from "../providers/RosterProvider";
import { useToast } from "./useToast";
import { queryKeys } from "../lib/queryKeys";
import { errorMessage } from "../lib/errorDisplay";
import type { DriveGoogleAccountStatus } from "../contracts/pending";

export function useDriveGoogleAccount(enabled: boolean): UseQueryResult<DriveGoogleAccountStatus> {
  const { api } = useRosterContext();
  return useQuery({
    queryKey: queryKeys.driveGoogleAccount(),
    queryFn: () => api.getDriveGoogleAccount(),
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
    mutationFn: (redirectUri: string) => api.startDriveGoogleConnect(redirectUri),
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
      qc.setQueryData(queryKeys.driveGoogleAccount(), status);
      toast({ kind: "success", title: "Google アカウントを接続しました", description: status.email ?? undefined });
    },
  });
}
