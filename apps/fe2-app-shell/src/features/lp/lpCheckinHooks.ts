// LP管理 → 受付 のデータフック。受付は「件数を先に +1 → 結果が ok でなければ戻す」、取り消しは
// 「一覧から先に外す → 失敗で戻す」の楽観的 UI（lpTicketsHooks.ts と同じ流儀）。
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@dub/ui";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useLpApi } from "./LpProvider.tsx";
import type { LpTicketCheckinResponse, LpTicketCheckinsPage, LpTicketCheckinUndoResponse } from "./lpApi.tsx";
import { withCheckinRow, withoutCheckin, withPendingCheckin } from "./lpCheckin.ts";

export const CHECKINS_PAGE_SIZE = 100;

export function lpCheckinsKey(day: string) {
  return queryKeys.feature("lp", "tickets", "checkins", day);
}

function messageFor(err: unknown, fallback: string): string {
  return ApiError.isApiError(err) ? toDisplayableError(err).message : fallback;
}

export function useTicketCheckins(day: string, enabled = true) {
  const api = useLpApi();
  return useQuery({
    queryKey: lpCheckinsKey(day),
    queryFn: () => api.listTicketCheckins({ day, limit: CHECKINS_PAGE_SIZE }),
    enabled,
    staleTime: 10 * 1000,
    // 受付は複数台で並行するので、他の端末の分も追いかける。
    refetchInterval: 30 * 1000,
  });
}

type Ctx = { prev: LpTicketCheckinsPage | undefined };

export function useCheckinTicket(day: string) {
  const api = useLpApi();
  const qc = useQueryClient();
  const toast = useToast();
  const key = lpCheckinsKey(day);
  return useMutation<LpTicketCheckinResponse, unknown, { code: string }, Ctx>({
    mutationFn: ({ code }) => api.checkinTicket({ code, eventDay: day }),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: key, exact: true });
      const prev = qc.getQueryData<LpTicketCheckinsPage>(key);
      if (prev) qc.setQueryData<LpTicketCheckinsPage>(key, withPendingCheckin(prev));
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.show({ kind: "error", title: messageFor(err, "受付できませんでした。通信を確かめてもう一度読んでください") });
    },
    onSuccess: (res, _vars, ctx) => {
      if (res.result === "ok") {
        const cur = qc.getQueryData<LpTicketCheckinsPage>(key);
        if (cur) qc.setQueryData(key, withCheckinRow(cur, res));
      } else if (ctx?.prev) {
        qc.setQueryData(key, ctx.prev);
      }
    },
  });
}

export function useUndoCheckin(day: string) {
  const api = useLpApi();
  const qc = useQueryClient();
  const toast = useToast();
  const key = lpCheckinsKey(day);
  return useMutation<LpTicketCheckinUndoResponse, unknown, { ticketId: string }, Ctx>({
    mutationFn: ({ ticketId }) => api.undoTicketCheckin(ticketId, day),
    onMutate: async ({ ticketId }) => {
      await qc.cancelQueries({ queryKey: key, exact: true });
      const prev = qc.getQueryData<LpTicketCheckinsPage>(key);
      if (prev) qc.setQueryData<LpTicketCheckinsPage>(key, withoutCheckin(prev, ticketId));
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.show({ kind: "error", title: messageFor(err, "受付を取り消せませんでした") });
    },
    onSuccess: () => {
      toast.show({ kind: "success", title: "受付を取り消しました" });
    },
  });
}
