// Optimistic mutation runner. Mirrors FE2's `createOptimisticMutation` contract
// (contracts/fe2.ts). Applies the change first, commits, and rolls back on
// failure — unless the spec's onError chooses to keep the optimistic state
// (e.g. 404 -> item already gone; FE5 §6 / test 4,5,6).

import type { OptimisticMutationSpec } from "../contracts/fe2";
import { isApiError } from "../contracts/fe2";

export async function runOptimistic<TArgs>(
  spec: OptimisticMutationSpec<TArgs>,
  args: TArgs,
): Promise<void> {
  const rollback = spec.optimistic(args);
  try {
    await spec.commit(args);
  } catch (err) {
    if (spec.onError) {
      spec.onError(err, rollback, args);
    } else {
      rollback();
    }
    throw err;
  }
}

// Convenience: treat a NOT_FOUND (404) as "keep the optimistic removal" and roll
// back everything else. Used by the inbox read/mark-read mutations.
export function keepOnNotFound(
  err: unknown,
  rollback: () => void,
  onDropped?: () => void,
): void {
  if (isApiError(err) && (err.status === 404 || err.code.endsWith("_NOT_FOUND"))) {
    onDropped?.(); // do NOT roll back — the row is removed instead (test 6)
    return;
  }
  rollback(); // test 5: 5xx / network -> roll back
}
