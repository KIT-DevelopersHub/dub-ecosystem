// Cross-cutting connection health for the shell banner (P1-3).
//
// WHY THIS EXISTS: only chat (FE6) surfaced a "connection lost" notice; every other
// app (mail / roster / events / gantt / notifications) failed silently when the
// network dropped or the api-gateway became unreachable — the screen just stopped
// updating with no explanation. This hook generalises that signal to the whole shell.
//
// Two independent signals combine into one status so the shell can tell apart "your
// network is down" from "the backend is down", and stay quiet when all is well:
//   • navigator online/offline — the browser's own network flag ("offline" wins).
//   • a periodic GET /healthz probe of the api-gateway — catches the case where the
//     browser thinks it's online but the gateway/backend is unreachable.
//
// status = offline (no network) | unreachable (network up, gateway down) | online.
import { useEffect, useState } from "react";

export type ConnectionHealth = "online" | "offline" | "unreachable";

export interface UseConnectionHealthOptions {
  /** API gateway base URL to probe (GET `${baseUrl}/healthz`). */
  baseUrl: string;
  /** Gates ONLY the /healthz probe (the "unreachable backend" signal). Default true.
   *  Set false for demo/mock builds that have no real backend, so they never show a
   *  false "サーバーに接続できません" — but note the navigator offline signal below is
   *  always active regardless, since it is backend-independent and universally valid
   *  (so an offline banner still works, and is demonstrable, even in a mock demo). */
  probeEnabled?: boolean;
  /** Health re-probe interval while the browser reports online (ms). */
  intervalMs?: number;
  /** Per-probe timeout (ms) before the gateway is treated as unreachable. */
  timeoutMs?: number;
  /** Injectable fetch (tests). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;

/** navigator.onLine, tolerant of environments where it is absent (SSR/tests): when
 *  unknown we assume online so the banner never appears on a false negative. */
function readOnLine(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

export function useConnectionHealth(options: UseConnectionHealthOptions): ConnectionHealth {
  const {
    baseUrl,
    probeEnabled = true,
    intervalMs = DEFAULT_INTERVAL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl,
  } = options;

  // navigator flag + last probe result. Kept as two booleans (not one status) so an
  // online/offline event and a probe result never clobber each other's signal.
  const [online, setOnline] = useState<boolean>(() => readOnLine());
  const [reachable, setReachable] = useState<boolean>(true);

  // navigator online/offline — always active: it needs no backend and is universally
  // valid, so the offline banner works in every build (real, demo, mock).
  useEffect(() => {
    function handleOnline(): void {
      setOnline(true);
    }
    function handleOffline(): void {
      setOnline(false);
    }
    setOnline(readOnLine());
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // /healthz probe — the "backend unreachable" signal. Runs only when probing is
  // enabled and a base URL is set; disabled builds (demo/mock) skip it entirely and
  // `reachable` stays true, so they never show a false "unreachable" banner.
  useEffect(() => {
    if (!probeEnabled || !baseUrl) {
      setReachable(true);
      return undefined;
    }
    const doFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
    let cancelled = false;

    async function probe(): Promise<void> {
      // Pointless (and misleading) to probe while the OS already reports offline —
      // the offline banner wins, and a fetch here would just error into "unreachable".
      if (!readOnLine() || !doFetch) return;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await doFetch(`${baseUrl.replace(/\/$/, "")}/healthz`, {
          method: "GET",
          signal: ctrl.signal,
          cache: "no-store",
        });
        if (!cancelled) setReachable(res.ok);
      } catch {
        // network error, timeout/abort, DNS failure — all mean "can't reach gateway".
        if (!cancelled) setReachable(false);
      } finally {
        clearTimeout(timer);
      }
    }

    // Re-verify the backend the moment the network returns, on top of the interval.
    function handleOnline(): void {
      void probe();
    }
    window.addEventListener("online", handleOnline);
    void probe();
    const poll = setInterval(() => void probe(), intervalMs);

    return () => {
      cancelled = true;
      window.removeEventListener("online", handleOnline);
      clearInterval(poll);
    };
  }, [baseUrl, probeEnabled, fetchImpl, intervalMs, timeoutMs]);

  if (!online) return "offline";
  return reachable ? "online" : "unreachable";
}
