// createOptimisticMutation — FE2 contract (design UI原則: 編集は楽観的UI、先に反映
// →失敗時ロールバック＋トースト、409 EVENT_VERSION_CONFLICT で rollback＋再取得).
// Implemented locally as part of the FE2 shim; repoint at @dub/app-shell on
// integration. Wraps TanStack useMutation with snapshot/rollback/invalidate.
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useToast } from "../contracts/fe1";
import { toDisplayableError } from "../contracts/fe2";
import { isVersionConflict } from "../lib/errorMap";

export interface OptimisticMutationConfig<TData, TVars, TCache> {
  mutationFn: (vars: TVars) => Promise<TData>;
  /** Cache key to snapshot, optimistically patch, roll back, and invalidate. */
  queryKey: QueryKey;
  /** Produce the optimistic cache value from the previous value + variables. */
  optimisticUpdate?: (prev: TCache | undefined, vars: TVars) => TCache | undefined;
  successMessage?: string;
  /** Extra hook fired on version conflict (after rollback + refetch). */
  onConflict?: () => void;
}

export interface OptimisticMutationCtx<TCache> {
  prev: TCache | undefined;
}

export function createOptimisticMutation<TData, TVars, TCache = unknown>(
  config: OptimisticMutationConfig<TData, TVars, TCache>,
) {
  const qc = useQueryClient();
  const toast = useToast();

  return useMutation<TData, unknown, TVars, OptimisticMutationCtx<TCache>>({
    mutationFn: config.mutationFn,
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: config.queryKey });
      const prev = qc.getQueryData<TCache>(config.queryKey);
      if (config.optimisticUpdate) {
        qc.setQueryData<TCache>(config.queryKey, (old) => config.optimisticUpdate!(old as TCache | undefined, vars));
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      // Roll back to the pre-mutation snapshot.
      if (ctx) qc.setQueryData(config.queryKey, ctx.prev);
      const de = toDisplayableError(err);
      if (isVersionConflict(de)) {
        void qc.invalidateQueries({ queryKey: config.queryKey }); // refetch latest for diff
        config.onConflict?.();
        toast.show({ message: "他の変更と競合しました。最新を取得しました。", variant: "error" });
      } else {
        toast.show({ message: de.message, variant: "error" });
      }
    },
    onSuccess: () => {
      if (config.successMessage) toast.show({ message: config.successMessage, variant: "success" });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: config.queryKey });
    },
  });
}
