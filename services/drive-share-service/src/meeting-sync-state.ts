// What the calendar sync remembers between runs: when it may touch Google Calendar again. Lives in
// MeetingSyncDO storage (no migration). The alarm reads it directly; a request (a write, or a manual
// POST /meetings/sync) goes through the DO, so both see one state and pause() is one atomic step.

export interface MeetingSyncSnapshot {
  /** Epoch ms; no Calendar call from the sync before this. */
  pausedUntil: number | null;
}

export interface MeetingSyncState {
  load(): Promise<MeetingSyncSnapshot>;
  /** Pause until `until` unless a pause is already running at `now`. started = this call began it. */
  pause(now: number, until: number): Promise<{ until: number; started: boolean }>;
}

/** The subset of DurableObjectStorage used here. */
export interface SyncStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

const PAUSED_UNTIL_KEY = "calendarPausedUntil";

export function createStorageSyncState(storage: SyncStorage): MeetingSyncState {
  return {
    async load() {
      return { pausedUntil: (await storage.get<number>(PAUSED_UNTIL_KEY)) ?? null };
    },
    async pause(now, until) {
      const current = await storage.get<number>(PAUSED_UNTIL_KEY);
      if (current !== undefined && current > now) return { until: current, started: false };
      await storage.put(PAUSED_UNTIL_KEY, until);
      return { until, started: true };
    },
  };
}

/** No DO binding (local runs, unit tests): the same rules, per isolate. */
export function createInMemorySyncState(): MeetingSyncState {
  const kv = new Map<string, unknown>();
  return createStorageSyncState({
    get: async <T>(key: string) => kv.get(key) as T | undefined,
    put: async (key, value) => void kv.set(key, value),
  });
}

/** The state of a request path, held by the DO (routes in meeting-sync-do.ts). */
export function createRemoteSyncState(call: (path: string, init?: RequestInit) => Promise<Response>): MeetingSyncState {
  const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await call(path, init);
    // A pause that cannot be read must stop the caller, not read as "no pause".
    if (!res.ok) throw new Error(`meeting sync state: ${res.status}`);
    return (await res.json()) as T;
  };
  return {
    load: () => json("/sync-state"),
    pause: (now, until) => json("/sync-state/pause", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ now, until }) }),
  };
}
