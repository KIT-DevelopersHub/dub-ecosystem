// Data hooks for 参加届: the 希望チーム list query + the submit mutation. The submit
// is a one-shot action (not an optimistic cache patch — its side effect lands on the
// members overview, which its own screen refetches), so we just surface success/error
// toasts and return the resolved outcome to the page for the サンクス view.
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useToast } from "@dub/ui";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useParticipationApi } from "./ParticipationProvider.tsx";
import type {
  ListParticipationsResponse,
  PublicParticipationResponse,
  ResolveParticipationRequest,
  ResolveParticipationResponse,
  SubmitParticipationRequest,
} from "./contracts.ts";

export const TEAMS_KEY: QueryKey = queryKeys.feature("participation", "teams");
export const LIST_KEY: QueryKey = queryKeys.feature("participation", "list");
/** 組織図(体制図)/名簿を描く members overview のキー。反映確定後に無効化して再描画する。 */
export const MEMBERS_OVERVIEW_KEY: QueryKey = queryKeys.feature("members", "overview");
export const CANDIDATES_KEY = (id: string): QueryKey => queryKeys.feature("participation", "candidates", id);

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

/** 突合候補（招待中/検討中で氏名/メール一致）。ダイアログを開くときだけ取得する
 *  (enabled で制御)。反映確定の分岐（同一人物 link / 新規 create）に使う。 */
export function useParticipationCandidates(id: string | null) {
  const api = useParticipationApi();
  return useQuery({
    queryKey: CANDIDATES_KEY(id ?? "none"),
    queryFn: () => api.candidates(id as string),
    enabled: id !== null,
    retry: false,
    staleTime: 30_000,
  });
}

/** 反映確定 (link/create/skip)。楽観的に一覧の reviewState を更新し、確定後は 参加届
 *  一覧＋組織図(members overview) を無効化して重複なく再描画する。失敗時はロールバック。 */
export function useResolveParticipation() {
  const api = useParticipationApi();
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<
    ResolveParticipationResponse,
    unknown,
    { id: string; body: ResolveParticipationRequest },
    { prev: ListParticipationsResponse | undefined }
  >({
    mutationFn: ({ id, body }) => api.resolve(id, body),
    onMutate: async ({ id, body }) => {
      await qc.cancelQueries({ queryKey: LIST_KEY });
      const prev = qc.getQueryData<ListParticipationsResponse>(LIST_KEY);
      const nextReviewState = body.action === "skip" ? "skipped" : "added";
      const nextMatchKind = body.action === "link" ? "linked_existing" : "created_new";
      qc.setQueryData<ListParticipationsResponse>(LIST_KEY, (old) =>
        old
          ? {
              participations: old.participations.map((p) =>
                p.id === id
                  ? { ...p, reviewState: nextReviewState, matchKind: body.action === "skip" ? p.matchKind : nextMatchKind }
                  : p,
              ),
            }
          : old,
      );
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(LIST_KEY, ctx.prev);
      const msg = ApiError.isApiError(err) ? toDisplayableError(err).message : "反映を確定できませんでした";
      toast.show({ kind: "error", title: msg });
    },
    onSuccess: (_res, { body }) => {
      const title =
        body.action === "skip"
          ? "対象外にしました"
          : body.action === "link"
            ? "招待中のメンバーに結びつけて追加しました"
            : "新規メンバーとして追加しました";
      toast.show({ kind: "success", title });
    },
    onSettled: () => {
      // サーバ確定値へ同期＋組織図(重複なし昇格/新ノード)を再描画。
      void qc.invalidateQueries({ queryKey: LIST_KEY });
      void qc.invalidateQueries({ queryKey: MEMBERS_OVERVIEW_KEY });
    },
  });
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
