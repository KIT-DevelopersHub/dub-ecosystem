// Unread-count poller (framework-free core). Polls at a fixed interval, pauses
// while the tab is hidden, and keeps the last value on failure (silent — test
// 10). The React hook wraps this; the core is injectable for tests.

export interface PollerDeps {
  fetchCount: () => Promise<number>;
  onValue: (count: number) => void;
  onError?: (err: unknown) => void; // silent by default (keep last value)
  intervalMs?: number; // default 60_000
  // Injectable clock/visibility for tests.
  setInterval?: (fn: () => void, ms: number) => number;
  clearInterval?: (id: number) => void;
  isHidden?: () => boolean; // default: document.hidden
}

export interface Poller {
  start(): void;
  stop(): void;
  // Force an immediate poll (used on mount + when tab becomes visible).
  poll(): Promise<void>;
}

const DEFAULT_INTERVAL_MS = 60_000;

export function createUnreadPoller(deps: PollerDeps): Poller {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const setIv = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms) as unknown as number);
  const clearIv = deps.clearInterval ?? ((id) => clearInterval(id));
  const isHidden =
    deps.isHidden ??
    (() => (typeof document !== "undefined" ? document.hidden : false));

  let timer: number | null = null;
  let inFlight = false;

  async function poll(): Promise<void> {
    if (isHidden()) return; // paused while hidden (test 10)
    if (inFlight) return; // no overlapping polls
    inFlight = true;
    try {
      const count = await deps.fetchCount();
      deps.onValue(count);
    } catch (err) {
      // Silent: keep last value; surface only if a handler wants it.
      deps.onError?.(err);
    } finally {
      inFlight = false;
    }
  }

  function start(): void {
    if (timer !== null) return;
    void poll(); // immediate first read
    timer = setIv(() => void poll(), intervalMs);
  }

  function stop(): void {
    if (timer !== null) {
      clearIv(timer);
      timer = null;
    }
  }

  return { start, stop, poll };
}
