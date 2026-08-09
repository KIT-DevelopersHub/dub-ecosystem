// Optimistic mutation runner. Mirrors FE2's `createOptimisticMutation` contract
// (all mutating flows must go through it — design §5) so the feature can be lifted
// into admin-spa by swapping this import. Snapshot -> apply -> mutate ->
// reconcile | rollback. Framework-free and fully unit-tested.

export interface OptimisticSpec<TState, TVars, TResult> {
  /** Optimistic state applied immediately (before the request resolves). */
  apply: (state: TState, vars: TVars) => TState;
  /** Reconcile with the server result on success. Defaults to identity. */
  reconcile?: (state: TState, vars: TVars, result: TResult) => TState;
  /** The server call. */
  mutate: (vars: TVars) => Promise<TResult>;
  /**
   * Rollback on error. Defaults to restoring the pre-apply snapshot. Return the
   * state to commit (e.g. mark a pending entry "failed" instead of removing it).
   */
  rollback?: (snapshot: TState, vars: TVars, error: unknown) => TState;
}

export interface StateBox<TState> {
  get: () => TState;
  set: (next: TState) => void;
}

/**
 * Run an optimistic mutation against a state box. On error the state is rolled
 * back (default: to the snapshot) and the error is rethrown so callers can map it
 * to UI (lib/errors.mapChatError).
 */
export async function runOptimistic<TState, TVars, TResult>(
  box: StateBox<TState>,
  spec: OptimisticSpec<TState, TVars, TResult>,
  vars: TVars,
): Promise<TResult> {
  const snapshot = box.get();
  box.set(spec.apply(snapshot, vars));
  try {
    const result = await spec.mutate(vars);
    if (spec.reconcile) box.set(spec.reconcile(box.get(), vars, result));
    return result;
  } catch (error) {
    const rolledBack = spec.rollback ? spec.rollback(snapshot, vars, error) : snapshot;
    box.set(rolledBack);
    throw error;
  }
}
