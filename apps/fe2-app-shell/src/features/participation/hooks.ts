// Data hooks for 参加届: the 希望チーム list query + the submit mutation. The submit
// is a one-shot action (not an optimistic cache patch — its side effect lands on the
// members overview, which its own screen refetches), so we just surface success/error
// toasts and return the resolved outcome to the page for the サンクス view.
import { useMutation, useQuery, type QueryKey } from "@tanstack/react-query";
import { useToast } from "@dub/ui";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useParticipationApi } from "./ParticipationProvider.tsx";
import type { PublicParticipationResponse, SubmitParticipationRequest } from "./contracts.ts";

export const TEAMS_KEY: QueryKey = queryKeys.feature("participation", "teams");
export const LIST_KEY: QueryKey = queryKeys.feature("participation", "list");

export function useParticipationTeams() {
  const api = useParticipationApi();
  // Populates the 希望チーム select. Non-fatal if the caller lacks identity:read:
  // the page falls back to submitting without a team.
  return useQuery({ queryKey: TEAMS_KEY, queryFn: () => api.listTeams(), retry: false });
}

export function useParticipationList() {
  const api = useParticipationApi();
  // 運営用の回答一覧 (identity:read gate is enforced server-side + on the route).
  return useQuery({ queryKey: LIST_KEY, queryFn: () => api.list() });
}

export function useSubmitParticipation() {
  const api = useParticipationApi();
  const toast = useToast();
  return useMutation<PublicParticipationResponse, unknown, SubmitParticipationRequest>({
    mutationFn: (input) => api.submit(input),
    onSuccess: () => {
      toast.show({ kind: "success", title: "参加届を送信しました" });
    },
    onError: (err) => {
      const msg = ApiError.isApiError(err) ? toDisplayableError(err).message : "参加届を送信できませんでした";
      toast.show({ kind: "error", title: msg });
    },
  });
}
