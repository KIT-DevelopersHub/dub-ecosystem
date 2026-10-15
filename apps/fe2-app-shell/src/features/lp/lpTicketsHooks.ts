// LP管理 → チケット のデータフック。書き込みはすべて楽観的 UI（先にキャッシュへ反映 → 失敗で
// スナップショットへ戻してエラートースト）。lpHooks.ts と同じ流儀。
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useToast } from "@dub/ui";
import { queryKeys } from "../../lib/queryKeys.tsx";
import { ApiError, toDisplayableError } from "../../lib/api-client.tsx";
import { useLpApi } from "./LpProvider.tsx";
import type {
  LpTicketCoupon,
  LpTicketCouponInput,
  LpTicketCouponsPage,
  LpTicketField,
  LpTicketOrder,
  LpTicketOrdersPage,
  LpTicketTypeInput,
  LpTicketTypeSummary,
  LpTicketsState,
} from "./lpApi.tsx";

const STALE_MS = 30 * 1000;
export const TICKET_ORDERS_PAGE_SIZE = 25;

export function lpTicketsKey() {
  return queryKeys.feature("lp", "tickets");
}

export function lpTicketOrdersKey() {
  return queryKeys.feature("lp", "tickets", "orders");
}

export function lpTicketCouponsKey() {
  return queryKeys.feature("lp", "tickets", "coupons");
}

function messageFor(err: unknown, fallback: string): string {
  return ApiError.isApiError(err) ? toDisplayableError(err).message : fallback;
}

/** 券種一覧から合計を引き直す（楽観更新中もサマリタイルが嘘をつかないように）。 */
function withTotals(state: LpTicketsState, types: LpTicketTypeSummary[]): LpTicketsState {
  return {
    ...state,
    types,
    totals: {
      sold: types.reduce((n, t) => n + t.stats.sold, 0),
      revenueJpy: types.reduce((n, t) => n + t.stats.revenueJpy, 0),
    },
  };
}

export function useLpTickets() {
  const api = useLpApi();
  return useQuery({ queryKey: lpTicketsKey(), queryFn: () => api.getTickets(), staleTime: STALE_MS });
}

type Ctx = { prev: LpTicketsState | undefined };

export function useSetTicketsEnabled() {
  const api = useLpApi();
  const qc = useQueryClient();
  const toast = useToast();
  const key = lpTicketsKey();
  return useMutation<LpTicketsState, unknown, { enabled: boolean }, Ctx>({
    mutationFn: (vars) => api.setTicketsEnabled(vars),
    onMutate: async ({ enabled }) => {
      await qc.cancelQueries({ queryKey: key, exact: true });
      const prev = qc.getQueryData<LpTicketsState>(key);
      if (prev) qc.setQueryData<LpTicketsState>(key, { ...prev, enabled });
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.show({ kind: "error", title: messageFor(err, "販売状態を切り替えられませんでした") });
    },
    onSuccess: (next) => {
      qc.setQueryData(key, next);
      toast.show({ kind: "success", title: next.enabled ? "チケット販売を公開しました" : "チケット販売を停止しました" });
    },
  });
}

/** LP の「参加登録」ボタン差し替え（ctaEnabled）。販売の公開と同じ楽観更新 + ロールバック。 */
export function useSetTicketsCta() {
  const api = useLpApi();
  const qc = useQueryClient();
  const toast = useToast();
  const key = lpTicketsKey();
  return useMutation<LpTicketsState, unknown, { enabled: boolean }, Ctx>({
    mutationFn: (vars) => api.setTicketsCta(vars),
    onMutate: async ({ enabled }) => {
      await qc.cancelQueries({ queryKey: key, exact: true });
      const prev = qc.getQueryData<LpTicketsState>(key);
      if (prev) qc.setQueryData<LpTicketsState>(key, { ...prev, ctaEnabled: enabled });
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.show({ kind: "error", title: messageFor(err, "参加登録ボタンの設定を切り替えられませんでした") });
    },
    onSuccess: (next) => {
      qc.setQueryData(key, next);
      toast.show({
        kind: "success",
        title: next.ctaEnabled
          ? next.enabled
            ? "LP の参加登録ボタンを「参加チケットを購入」に切り替えました"
            : "参加登録ボタンの切り替えを予約しました（販売を公開すると有効になります）"
          : "LP の参加登録ボタンを元に戻しました",
      });
    },
  });
}

export function useSaveTicketFields() {
  const api = useLpApi();
  const qc = useQueryClient();
  const toast = useToast();
  const key = lpTicketsKey();
  return useMutation<LpTicketsState, unknown, { fields: LpTicketField[] }, Ctx>({
    mutationFn: (vars) => api.saveTicketFields(vars),
    onMutate: async ({ fields }) => {
      await qc.cancelQueries({ queryKey: key, exact: true });
      const prev = qc.getQueryData<LpTicketsState>(key);
      if (prev) qc.setQueryData<LpTicketsState>(key, { ...prev, fields });
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

const OPTIMISTIC_PREFIX = "optimistic:";

/** 券種の追加（id なし）と部分更新（id あり）を 1 本で扱う。販売中トグルも更新側を使う。 */
export function useSaveTicketType() {
  const api = useLpApi();
  const qc = useQueryClient();
  const toast = useToast();
  const key = lpTicketsKey();
  return useMutation<
    LpTicketTypeSummary,
    unknown,
    { id?: string; input: Partial<LpTicketTypeInput>; toast?: string },
    Ctx & { tempId: string | null }
  >({
    mutationFn: ({ id, input }) =>
      id ? api.updateTicketType(id, input) : api.createTicketType(input as LpTicketTypeInput),
    onMutate: async ({ id, input }) => {
      await qc.cancelQueries({ queryKey: key, exact: true });
      const prev = qc.getQueryData<LpTicketsState>(key);
      let tempId: string | null = null;
      if (prev) {
        let types: LpTicketTypeSummary[];
        if (id) {
          types = prev.types.map((t) => (t.id === id ? { ...t, ...input } : t));
        } else {
          tempId = `${OPTIMISTIC_PREFIX}${Date.now()}`;
          const now = new Date().toISOString();
          const full = input as LpTicketTypeInput;
          types = [
            ...prev.types,
            {
              ...full,
              id: tempId,
              sortOrder: prev.types.length,
              createdAt: now,
              updatedAt: now,
              stats: { sold: 0, pending: 0, revenueJpy: 0, remaining: full.capacity },
            },
          ];
        }
        qc.setQueryData<LpTicketsState>(key, withTotals(prev, types));
      }
      return { prev, tempId };
    },
    onError: (err, vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.show({
        kind: "error",
        title: messageFor(err, vars.id ? "券種を更新できませんでした" : "券種を追加できませんでした"),
      });
    },
    onSuccess: (saved, vars, ctx) => {
      qc.setQueryData<LpTicketsState>(key, (old) => {
        if (!old) return old;
        const replaceId = vars.id ?? ctx?.tempId;
        const exists = old.types.some((t) => t.id === replaceId);
        const types = exists ? old.types.map((t) => (t.id === replaceId ? saved : t)) : [...old.types, saved];
        return withTotals(old, types);
      });
      toast.show({ kind: "success", title: vars.toast ?? (vars.id ? "券種を更新しました" : `券種を追加しました（${saved.name}）`) });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key, exact: true });
    },
  });
}

/** 購入者一覧（個人情報なので app:lp:edit のときだけ取りにいく）。 */
export function useLpTicketOrders(enabled: boolean) {
  const api = useLpApi();
  return useInfiniteQuery({
    queryKey: lpTicketOrdersKey(),
    queryFn: ({ pageParam }) =>
      api.listTicketOrders({ limit: TICKET_ORDERS_PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: STALE_MS,
    enabled,
  });
}

type OrderPages = InfiniteData<LpTicketOrdersPage, string | null>;

function replaceOrder(pages: OrderPages, id: string, patch: (o: LpTicketOrder) => LpTicketOrder): OrderPages {
  return { ...pages, pages: pages.pages.map((p) => ({ ...p, items: p.items.map((o) => (o.id === id ? patch(o) : o)) })) };
}

/** 要確認の注文を支払い済みに確定。先に行を「支払い済み」にし、失敗で戻す。販売数・売上はサーバー集計を取り直す。 */
export function useApproveTicketOrder() {
  const api = useLpApi();
  const qc = useQueryClient();
  const toast = useToast();
  const ordersKey = lpTicketOrdersKey();
  const stateKey = lpTicketsKey();
  return useMutation<LpTicketOrder, unknown, { id: string }, { prev: OrderPages | undefined }>({
    mutationFn: ({ id }) => api.approveTicketOrder(id),
    onMutate: async ({ id }) => {
      await qc.cancelQueries({ queryKey: ordersKey, exact: true });
      const prev = qc.getQueryData<OrderPages>(ordersKey);
      if (prev) qc.setQueryData<OrderPages>(ordersKey, replaceOrder(prev, id, (o) => ({ ...o, status: "paid" })));
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(ordersKey, ctx.prev);
      toast.show({ kind: "error", title: messageFor(err, "注文を確定できませんでした") });
    },
    onSuccess: (saved) => {
      qc.setQueryData<OrderPages>(ordersKey, (old) => (old ? replaceOrder(old, saved.id, () => saved) : old));
      toast.show({ kind: "success", title: `${saved.buyerName} さんの注文を確定しました` });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ordersKey, exact: true });
      void qc.invalidateQueries({ queryKey: stateKey, exact: true });
    },
  });
}

/** 無料券のクーポン一覧（app:lp:edit + lp:publish のときだけ取りにいく）。 */
export function useLpTicketCoupons(enabled: boolean) {
  const api = useLpApi();
  return useQuery({ queryKey: lpTicketCouponsKey(), queryFn: () => api.listTicketCoupons(), staleTime: STALE_MS, enabled });
}

/**
 * クーポンの発行。コードはサーバーが作るので楽観的に行を足さない（仮のコードを見せてコピーされる事故を防ぐ）。
 * 成功したら先頭へ差し込む。
 */
export function useCreateTicketCoupon() {
  const api = useLpApi();
  const qc = useQueryClient();
  const toast = useToast();
  const key = lpTicketCouponsKey();
  return useMutation<LpTicketCoupon, unknown, LpTicketCouponInput>({
    mutationFn: (input) => api.createTicketCoupon(input),
    onError: (err) => {
      toast.show({ kind: "error", title: messageFor(err, "クーポンを発行できませんでした") });
    },
    onSuccess: (saved) => {
      qc.setQueryData<LpTicketCouponsPage>(key, (old) =>
        old ? { items: [saved, ...old.items.filter((c) => c.id !== saved.id)] } : { items: [saved] },
      );
      toast.show({ kind: "success", title: `クーポンを発行しました（${saved.code}）` });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: key, exact: true });
    },
  });
}

/** クーポンの停止/再開。先に行を切り替え、失敗で戻す。 */
export function useSetTicketCouponActive() {
  const api = useLpApi();
  const qc = useQueryClient();
  const toast = useToast();
  const key = lpTicketCouponsKey();
  return useMutation<LpTicketCoupon, unknown, { id: string; active: boolean }, { prev: LpTicketCouponsPage | undefined }>({
    mutationFn: ({ id, active }) => api.setTicketCouponActive(id, { active }),
    onMutate: async ({ id, active }) => {
      await qc.cancelQueries({ queryKey: key, exact: true });
      const prev = qc.getQueryData<LpTicketCouponsPage>(key);
      if (prev) qc.setQueryData<LpTicketCouponsPage>(key, { items: prev.items.map((c) => (c.id === id ? { ...c, active } : c)) });
      return { prev };
    },
    onError: (err, vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.show({ kind: "error", title: messageFor(err, vars.active ? "クーポンを再開できませんでした" : "クーポンを停止できませんでした") });
    },
    onSuccess: (saved) => {
      qc.setQueryData<LpTicketCouponsPage>(key, (old) =>
        old ? { items: old.items.map((c) => (c.id === saved.id ? saved : c)) } : old,
      );
      toast.show({ kind: "success", title: saved.active ? `クーポン ${saved.code} を再開しました` : `クーポン ${saved.code} を停止しました` });
    },
  });
}
