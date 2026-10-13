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
  ListOnboardingItemsResponse,
  ListParticipationsResponse,
  OnboardingItem,
  OnboardingItemInput,
  PublicParticipationResponse,
  ResolveParticipationRequest,
  ResolveParticipationResponse,
  SubmitParticipationRequest,
  UpdateOnboardingItemRequest,
} from "./contracts.ts";

export const TEAMS_KEY: QueryKey = queryKeys.feature("participation", "teams");
export const LIST_KEY: QueryKey = queryKeys.feature("participation", "list");
/** 組織図(体制図)/名簿を描く members overview のキー。反映確定後に無効化して再描画する。 */
export const MEMBERS_OVERVIEW_KEY: QueryKey = queryKeys.feature("members", "overview");
export const ONBOARDING_KEY: QueryKey = queryKeys.feature("participation", "onboarding");
export const PUBLIC_ONBOARDING_KEY: QueryKey = queryKeys.feature("participation", "onboarding", "public");
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

/** 名簿全体（手動紐付けの検索対象）。「名簿から手動で選ぶ」を開いた時だけ取得する
 *  (enabled)。自動候補に載らない相手（漢字違い等）も検索して link できるようにする。 */
export function useParticipationRosterMembers(enabled: boolean) {
  const api = useParticipationApi();
  return useQuery({
    queryKey: MEMBERS_OVERVIEW_KEY,
    queryFn: () => api.overview(),
    enabled,
    staleTime: 30_000,
  });
}

/** 反映確定 (link/create/skip/unlink)。楽観的に一覧の reviewState を更新し、確定後は 参加届
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
      const roster = body.action === "link" || body.action === "create";
      const nextReviewState = body.action === "skip" ? "skipped" : body.action === "unlink" ? "pending" : "added";
      const nextMatchKind = body.action === "link" ? "linked_existing" : "created_new";
      qc.setQueryData<ListParticipationsResponse>(LIST_KEY, (old) =>
        old
          ? {
              participations: old.participations.map((p) =>
                p.id === id
                  ? {
                      ...p,
                      reviewState: nextReviewState,
                      matchKind: roster ? nextMatchKind : p.matchKind,
                      memberId: roster ? p.memberId : null,
                    }
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
          : body.action === "unlink"
            ? "紐付けを解除して未処理に戻しました"
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

// ---- オンボーディング案内 -----------------------------------------------------------

/** 管理タブの項目一覧。 */
export function useOnboardingItems() {
  const api = useParticipationApi();
  return useQuery({ queryKey: ONBOARDING_KEY, queryFn: () => api.listOnboarding() });
}

/** 公開ページの項目一覧 (未ログイン)。 */
export function usePublicOnboardingItems() {
  const api = useParticipationApi();
  return useQuery({ queryKey: PUBLIC_ONBOARDING_KEY, queryFn: () => api.publicOnboarding() });
}

type OnboardingSnapshot = { prev: ListOnboardingItemsResponse | undefined };

/** 楽観更新の共通部: 一覧を先に書き換え、失敗したら戻してトースト、最後にサーバ値へ同期。 */
function useOnboardingMutation<TVars, TRes>(
  mutationFn: (vars: TVars) => Promise<TRes>,
  patch: (items: OnboardingItem[], vars: TVars) => OnboardingItem[],
  messages: { success?: string; error: string },
) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<TRes, unknown, TVars, OnboardingSnapshot>({
    mutationFn,
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ONBOARDING_KEY });
      const prev = qc.getQueryData<ListOnboardingItemsResponse>(ONBOARDING_KEY);
      qc.setQueryData<ListOnboardingItemsResponse>(ONBOARDING_KEY, (old) =>
        old ? { items: patch(old.items, vars) } : old,
      );
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(ONBOARDING_KEY, ctx.prev);
      const msg = ApiError.isApiError(err) ? toDisplayableError(err).message : messages.error;
      toast.show({ kind: "error", title: msg });
    },
    onSuccess: () => {
      if (messages.success) toast.show({ kind: "success", title: messages.success });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ONBOARDING_KEY });
    },
  });
}

const PENDING_ID_PREFIX = "pending-";

/** 追加中の仮行か (サーバ id 未確定。編集・並び替えの対象にしない)。 */
export function isPendingOnboardingItem(item: OnboardingItem): boolean {
  return item.id.startsWith(PENDING_ID_PREFIX);
}

export function useCreateOnboardingItem() {
  const api = useParticipationApi();
  return useOnboardingMutation<OnboardingItemInput, OnboardingItem>(
    (input) => api.createOnboarding(input),
    (items, input) => {
      const now = new Date().toISOString();
      const last = items[items.length - 1];
      return [
        ...items,
        {
          id: `${PENDING_ID_PREFIX}${now}`,
          title: input.title,
          description: input.description ?? null,
          url: input.url ?? null,
          sortOrder: (last?.sortOrder ?? 0) + 1,
          createdAt: now,
          updatedAt: now,
        },
      ];
    },
    { success: "項目を追加しました", error: "項目を追加できませんでした" },
  );
}

export function useUpdateOnboardingItem() {
  const api = useParticipationApi();
  return useOnboardingMutation<{ id: string; patch: UpdateOnboardingItemRequest }, OnboardingItem>(
    ({ id, patch }) => api.updateOnboarding(id, patch),
    (items, { id, patch }) => items.map((i) => (i.id === id ? { ...i, ...patch } : i)),
    { success: "項目を更新しました", error: "項目を更新できませんでした" },
  );
}

export function useDeleteOnboardingItem() {
  const api = useParticipationApi();
  return useOnboardingMutation<string, void>(
    (id) => api.deleteOnboarding(id),
    (items, id) => items.filter((i) => i.id !== id),
    { success: "項目を削除しました", error: "項目を削除できませんでした" },
  );
}

export function useReorderOnboardingItems() {
  const api = useParticipationApi();
  return useOnboardingMutation<string[], ListOnboardingItemsResponse>(
    (ids) => api.reorderOnboarding(ids),
    (items, ids) => {
      const byId = new Map(items.map((i) => [i.id, i]));
      return ids.map((id) => byId.get(id)).filter((i): i is OnboardingItem => i !== undefined);
    },
    // 並び替えは頻繁なので成功トーストは出さない（見た目がそのまま結果）。
    { error: "並び順を保存できませんでした" },
  );
}
