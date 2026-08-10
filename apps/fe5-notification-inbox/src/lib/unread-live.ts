// Live unread-count source (framework-free core). Gives the header bell a push
// path so the badge updates the moment the server emits a new unread count,
// instead of waiting up to a full poll interval (FE5 §1). The poller stays as
// the reconciliation fallback — this source is purely additive and optional.
//
// The transport is injected (`LiveConnector`) so the reconnect/backoff logic is
// unit-testable without a real EventSource. A concrete Server-Sent-Events
// connector (`createSseUnreadConnector`) is provided for the SPA shell / dev
// harness to wire against the gateway stream endpoint.

export interface LiveHandlers {
  // A fresh absolute unread count pushed by the server.
  onCount: (count: number) => void;
  // Transport error — the reconnecting source reacts by backing off.
  onError?: (err: unknown) => void;
  // Connection established (resets backoff).
  onOpen?: () => void;
}

// A live connection is anything that can be closed. The connector wires the
// handlers to an underlying transport and returns the handle.
export interface LiveConnection {
  close(): void;
}

// Opens exactly ONE connection, forwarding transport events to `handlers`.
export type LiveConnector = (handlers: LiveHandlers) => LiveConnection;

export type LiveStatus = "connecting" | "open" | "closed";

export interface UnreadLiveSource {
  start(): void;
  stop(): void;
}

export interface ReconnectingLiveDeps {
  connect: LiveConnector;
  onValue: (count: number) => void;
  onStatus?: (status: LiveStatus) => void;
  // Exponential backoff bounds (injectable clock for tests).
  baseDelayMs?: number; // default 1_000
  maxDelayMs?: number; // default 30_000
  setTimeout?: (fn: () => void, ms: number) => number;
  clearTimeout?: (id: number) => void;
}

const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;

// Wraps a one-shot connector with reconnect-on-error and exponential backoff.
// `start()` opens a connection; a transport error tears it down and schedules a
// backed-off reconnect; `stop()` closes and prevents any further reconnect.
export function createReconnectingUnreadLive(deps: ReconnectingLiveDeps): UnreadLiveSource {
  const baseDelay = deps.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelay = deps.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number);
  const clearT = deps.clearTimeout ?? ((id) => clearTimeout(id));

  let stopped = true;
  let conn: LiveConnection | null = null;
  let reconnectTimer: number | null = null;
  let attempt = 0;

  function closeConn(): void {
    if (conn) {
      try {
        conn.close();
      } catch {
        // ignore transport close errors
      }
      conn = null;
    }
  }

  function clearReconnect(): void {
    if (reconnectTimer !== null) {
      clearT(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    if (reconnectTimer !== null) return; // a reconnect is already pending
    closeConn();
    deps.onStatus?.("closed");
    const delay = Math.min(maxDelay, baseDelay * 2 ** attempt);
    attempt += 1;
    reconnectTimer = setT(() => {
      reconnectTimer = null;
      open();
    }, delay);
  }

  function open(): void {
    if (stopped) return;
    deps.onStatus?.("connecting");
    conn = deps.connect({
      onOpen: () => {
        attempt = 0; // healthy connection -> reset backoff
        deps.onStatus?.("open");
      },
      onCount: (count) => deps.onValue(count),
      onError: () => scheduleReconnect(),
    });
  }

  return {
    start() {
      if (!stopped) return; // idempotent
      stopped = false;
      attempt = 0;
      open();
    },
    stop() {
      stopped = true;
      clearReconnect();
      closeConn();
      deps.onStatus?.("closed");
    },
  };
}

// ---- Concrete Server-Sent-Events connector ---------------------------------

// The subset of EventSource this connector drives (kept minimal + injectable so
// tests can pass a fake and jsdom's lack of EventSource is a non-issue).
export interface EventSourceLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  addEventListener?(type: string, listener: (ev: { data: string }) => void): void;
  close(): void;
}

export type EventSourceCtor = new (
  url: string,
  init?: { withCredentials?: boolean },
) => EventSourceLike;

export interface SseUnreadConnectorConfig {
  url: string;
  // Defaults to the global EventSource; injectable for tests / SSR guards.
  EventSourceCtor?: EventSourceCtor;
  withCredentials?: boolean;
  // Named SSE event to listen for in addition to unnamed `message` frames.
  eventName?: string; // default "unread-count"
  parse?: (data: string) => number | null;
}

// Parse an SSE frame body into an unread count. Accepts `{"count":n}`, a bare
// JSON number, or a plain integer string; anything else yields null (ignored).
export function parseUnreadCount(data: string): number | null {
  const trimmed = data.trim();
  if (trimmed === "") return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "number") return Number.isFinite(parsed) ? parsed : null;
    if (parsed && typeof parsed === "object") {
      const count = (parsed as { count?: unknown }).count;
      if (typeof count === "number" && Number.isFinite(count)) return count;
    }
    return null;
  } catch {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
}

export function createSseUnreadConnector(config: SseUnreadConnectorConfig): LiveConnector {
  const parse = config.parse ?? parseUnreadCount;
  const eventName = config.eventName ?? "unread-count";
  return (handlers) => {
    const Ctor =
      config.EventSourceCtor ??
      (globalThis as { EventSource?: EventSourceCtor }).EventSource;
    if (!Ctor) {
      // No SSE transport (e.g. SSR / unsupported) -> report so the source can
      // back off; polling remains the fallback either way.
      handlers.onError?.(new Error("EventSource is not available"));
      return { close() {} };
    }
    const es = new Ctor(
      config.url,
      config.withCredentials !== undefined ? { withCredentials: config.withCredentials } : undefined,
    );
    const handleData = (data: string): void => {
      const count = parse(data);
      if (count !== null) handlers.onCount(count);
    };
    es.onopen = () => handlers.onOpen?.();
    es.onmessage = (ev) => handleData(ev.data);
    es.onerror = (ev) => handlers.onError?.(ev);
    if (typeof es.addEventListener === "function") {
      es.addEventListener(eventName, (ev) => handleData(ev.data));
    }
    return {
      close() {
        es.close();
      },
    };
  };
}
