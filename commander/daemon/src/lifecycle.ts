// Self-healing for runs a daemon restart orphans. A run's claude child dies with the daemon
// (dev-up restart, crash, Ctrl-C), but its commander_runs row would stay `running` forever
// and the board would show 実行中 permanently. Two best-effort halves:
//   - boot: ask commander-service to fail every pending/running run created before this
//     daemon started (none of them can still be alive), retrying in the background;
//   - shutdown (SIGTERM/SIGINT): fail this daemon's own in-flight runs before exiting.
// Neither may ever block boot or hang an exit.
import type { RunStore } from "./runner.ts";
import type { RunSink } from "./sink.ts";

/** Shown in the run log of every run a restart interrupted. */
export const ORPHAN_NOTICE =
  "[commander] commanderの再起動でこの実行は中断されました。もう一度送ってください。";

type FetchLike = typeof fetch;

export interface BootReconcileOptions {
  serviceUrl: string;
  serviceToken?: string;
  /** This daemon's start instant (ISO): only runs created before it are swept. */
  before: string;
  /** Run ids this daemon already owns (spared even if created before `before`). */
  ownedIds?: () => string[];
  attempts?: number;
  delayMs?: number;
  fetchImpl?: FetchLike;
  log?: (msg: string) => void;
}

/**
 * POST /runs/reconcile until it succeeds or `attempts` run out (linear backoff). Resolves
 * with the reconciled run ids, or null when the service never answered — never rejects.
 */
export async function reconcileAtBoot(opts: BootReconcileOptions): Promise<string[] | null> {
  const attempts = opts.attempts ?? 5;
  const delayMs = opts.delayMs ?? 3000;
  const doFetch = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((m: string) => console.warn(m));
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.serviceToken) headers["x-commander-token"] = opts.serviceToken;
  const url = `${opts.serviceUrl.replace(/\/+$/, "")}/runs/reconcile`;

  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          before: opts.before,
          exceptIds: opts.ownedIds?.() ?? [],
          line: ORPHAN_NOTICE,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json().catch(() => ({}))) as { reconciled?: unknown };
      const ids = Array.isArray(body.reconciled)
        ? body.reconciled.filter((x): x is string => typeof x === "string")
        : [];
      if (ids.length > 0) log(`[commander-daemon] marked ${ids.length} orphaned run(s) failed: ${ids.join(", ")}`);
      return ids;
    } catch (err) {
      log(`[commander-daemon] orphan-run reconcile attempt ${i}/${attempts} failed: ${(err as Error).message}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, delayMs * i));
    }
  }
  return null;
}

/**
 * Graceful shutdown: fail every in-flight run with the notice (mirrored to the sink) and
 * wait at most `timeoutMs` for those writes. Returns the aborted run ids.
 */
export async function abortInFlightRuns(
  store: RunStore,
  sink: RunSink,
  timeoutMs = 3000,
): Promise<string[]> {
  const ids = store.abortAll(ORPHAN_NOTICE);
  if (ids.length > 0 && sink.flush) await sink.flush(timeoutMs);
  return ids;
}
