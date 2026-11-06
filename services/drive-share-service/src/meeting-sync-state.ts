// What the calendar sync remembers between runs: when it may touch Google Calendar again, and how
// each calendar's shares stood. Lives in MeetingSyncDO storage (no migration). The alarm reads it directly; a request (a write, or a manual
// POST /meetings/sync) goes through the DO, so both see one state and pause() is one atomic step.

/** One calendar's shares as of its last finished reconcile. */
export interface CalendarAclState {
  /** Hash of the share list that reconcile finished for. */
  fingerprint: string | null;
  /** Epoch ms of that reconcile's listAcl. */
  checkedAt: number;
  /** "add:<email>" / "remove:<email>" that failed -> epoch ms of the next try. */
  retryAt: Record<string, number>;
}

export interface MeetingSyncSnapshot {
  /** Epoch ms; no Calendar call from the sync before this. */
  pausedUntil: number | null;
  /** Epoch ms; no share written before this (the pace, whichever run comes next). */
  aclWritesNotBefore: number;
  /** calendarId -> state. */
  acl: Record<string, CalendarAclState>;
}

export interface MeetingSyncState {
  load(): Promise<MeetingSyncSnapshot>;
  /** Pause until `until` unless a pause is already running at `now`. started = this call began it. */
  pause(now: number, until: number): Promise<{ until: number; started: boolean }>;
  /** Merge per calendar: a run saves only the calendars it touched. */
  saveAcl(update: { acl: Record<string, CalendarAclState>; aclWritesNotBefore?: number }): Promise<void>;
}

/** The subset of DurableObjectStorage used here. */
export interface SyncStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

const PAUSED_UNTIL_KEY = "calendarPausedUntil";
const ACL_NOT_BEFORE_KEY = "aclWritesNotBefore";
const ACL_KEY = "aclState";

export function createStorageSyncState(storage: SyncStorage): MeetingSyncState {
  return {
    async load() {
      return {
        pausedUntil: (await storage.get<number>(PAUSED_UNTIL_KEY)) ?? null,
        aclWritesNotBefore: (await storage.get<number>(ACL_NOT_BEFORE_KEY)) ?? 0,
        acl: (await storage.get<MeetingSyncSnapshot["acl"]>(ACL_KEY)) ?? {},
      };
    },
    async pause(now, until) {
      const current = await storage.get<number>(PAUSED_UNTIL_KEY);
      if (current !== undefined && current > now) return { until: current, started: false };
      await storage.put(PAUSED_UNTIL_KEY, until);
      return { until, started: true };
    },
    async saveAcl(update) {
      const acl = (await storage.get<MeetingSyncSnapshot["acl"]>(ACL_KEY)) ?? {};
      await storage.put(ACL_KEY, { ...acl, ...update.acl });
      if (update.aclWritesNotBefore !== undefined) await storage.put(ACL_NOT_BEFORE_KEY, update.aclWritesNotBefore);
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
    saveAcl: async (update) => void (await json("/sync-state/acl", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(update) })),
  };
}
