// createOptimisticMutation (design 2-6, [[optimistic-ui-principle]]).
// FE3-FE7 MUST route edit/grant mutations through this helper (no ad-hoc impls):
// onMutate cache-first update -> onError rollback + error toast -> onSettled invalidate.
// Destructive ops (delete / role-revoke / permission-bundle-save / archive) are
// NON-optimistic behind ConfirmDialog and MUST NOT use this helper.
import type { QueryClient, UseMutationOptions } from "@tanstack/react-query";
import type { ApiError } from "./api-client.tsx";

export interface OptimisticMutationOpts<TData, TVariables, TCache> {
  mutationFn: (v: TVariables) => Promise<TData>;
  cacheKey: readonly unknown[];
  applyOptimistic: (prev: TCache, v: TVariables) => TCache;
  /** Optional toast hook: shells wire FE1 useToast().show here on error. */
  onErrorToast?: (error: ApiError) => void;
}

interface OptimisticContext<TCache> {
  previous: TCache | undefined;
}

export function createOptimisticMutation<TData, TVariables, TCache>(
  queryClient: QueryClient,
  opts: OptimisticMutationOpts<TData, TVariables, TCache>,
): UseMutationOptions<TData, ApiError, TVariables, OptimisticContext<TCache>> {
  return {
    mutationFn: opts.mutationFn,
    onMutate: async (variables: TVariables) => {
      await queryClient.cancelQueries({ queryKey: opts.cacheKey });
      const previous = queryClient.getQueryData<TCache>(opts.cacheKey);
      if (previous !== undefined) {
        queryClient.setQueryData<TCache>(opts.cacheKey, opts.applyOptimistic(previous, variables));
      }
      return { previous };
    },
    onError: (error: ApiError, _variables: TVariables, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData<TCache>(opts.cacheKey, context.previous);
      }
      opts.onErrorToast?.(error);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: opts.cacheKey });
    },
  };
}
