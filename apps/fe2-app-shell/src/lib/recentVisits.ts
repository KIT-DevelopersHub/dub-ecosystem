// P3-1「最近開いたジャンプ」— recent-visit store (localStorage-backed).
//
// Records the places the viewer just opened (an event, a chat channel, a roster
// member, a mail thread, …) so the dashboard can offer a one-click "最近開いた"
// jump back. Purely client-side: nothing is sent to the backend, so it works the
// same in the backend-free demo build and against the live gateway.
//
// Contract:
//   • dedup by path — the same destination appears once, at the top (most recent).
//   • capped — only the newest MAX_RECENT_VISITS are kept.
//   • resilient — every localStorage touch is guarded; a private-mode / quota /
//     parse failure degrades to an empty list, never throws into React render.
//   • stable snapshot — getRecentVisits() returns a cached array reference that
//     only changes when the data changes, so it is safe for useSyncExternalStore.
import type { IconName } from "@dub/ui";
import type { NavEntry } from "../modules/types.tsx";

export interface RecentVisit {
  /** Full in-app pathname to restore, e.g. "/events/evt_1". */
  path: string;
  /** Human label — the page heading when captured, else the owning app's name. */
  label: string;
  /** Owning app's name (context line under the label), e.g. "イベント". */
  app: string;
  /** Owning app's icon. */
  icon: IconName;
  /** Epoch ms of the most recent visit. */
  at: number;
}

export const RECENT_VISITS_KEY = "dub.fe2.recentVisits.v1";
export const MAX_RECENT_VISITS = 8;

type Listener = () => void;
const listeners = new Set<Listener>();

// Cached snapshot so getRecentVisits() returns a stable reference between changes
// (required by useSyncExternalStore — a fresh array every call would loop).
let cache: RecentVisit[] | null = null;
let storageBound = false;

function storage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    // Accessing localStorage can itself throw (sandboxed iframe / blocked cookies).
    return null;
  }
}

function isValid(v: unknown): v is RecentVisit {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.path === "string" &&
    r.path.length > 0 &&
    typeof r.label === "string" &&
    typeof r.app === "string" &&
    typeof r.icon === "string" &&
    typeof r.at === "number"
  );
}

function readRaw(): RecentVisit[] {
  const s = storage();
  if (!s) return [];
  try {
    const text = s.getItem(RECENT_VISITS_KEY);
    if (!text) return [];
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValid).slice(0, MAX_RECENT_VISITS);
  } catch {
    return [];
  }
}

function ensureCache(): RecentVisit[] {
  if (cache === null) cache = readRaw();
  return cache;
}

function persist(next: RecentVisit[]): void {
  cache = next;
  const s = storage();
  if (s) {
    try {
      s.setItem(RECENT_VISITS_KEY, JSON.stringify(next));
    } catch {
      // Quota / private mode — keep the in-memory cache so the current tab still
      // shows the list; it just won't survive a reload. Never throw.
    }
  }
  for (const l of listeners) l();
}

/** Current recent visits, most-recent-first. Stable reference between changes. */
export function getRecentVisits(): RecentVisit[] {
  return ensureCache();
}

/** Record (or bump) a visit. Dedups by path and caps to MAX_RECENT_VISITS. */
export function recordVisit(v: Omit<RecentVisit, "at"> & { at?: number }): void {
  const at = v.at ?? Date.now();
  const entry: RecentVisit = { path: v.path, label: v.label, app: v.app, icon: v.icon, at };
  const prev = ensureCache();
  const deduped = prev.filter((r) => r.path !== entry.path);
  const next = [entry, ...deduped].slice(0, MAX_RECENT_VISITS);
  persist(next);
}

/** Clear the whole history (exposed for a future "履歴を消す" affordance / tests). */
export function clearRecentVisits(): void {
  persist([]);
}

/** Subscribe to changes (same-tab writes + cross-tab storage events). */
export function subscribeRecentVisits(listener: Listener): () => void {
  listeners.add(listener);
  if (!storageBound && typeof window !== "undefined") {
    storageBound = true;
    window.addEventListener("storage", (e) => {
      if (e.key !== null && e.key !== RECENT_VISITS_KEY) return;
      // Another tab changed it — drop the cache so the next snapshot re-reads, then
      // notify our own subscribers to re-render.
      cache = readRaw();
      for (const l of listeners) l();
    });
  }
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: reset the in-memory cache (localStorage untouched). */
export function __resetRecentVisitsCache(): void {
  cache = null;
}

// ── label / icon resolution ────────────────────────────────────────────────────

/** Owning-app metadata for a pathname, matched against the nav registry. */
export interface VisitAppMeta {
  app: string;
  icon: IconName;
}

// Routes that are not meaningful "places" to jump back to.
const UNTRACKED_EXACT = new Set<string>(["/", "/login"]);

function isPrefixAtBoundary(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/**
 * Resolve the owning app (label + icon) for a pathname by longest-prefix match
 * against the registered nav entries. Returns null for untracked routes (home /
 * login) or a path that belongs to no registered app.
 */
export function resolveVisitApp(pathname: string, navEntries: NavEntry[]): VisitAppMeta | null {
  if (UNTRACKED_EXACT.has(pathname)) return null;
  let best: NavEntry | null = null;
  for (const entry of navEntries) {
    if (!entry.path.startsWith("/")) continue;
    if (!isPrefixAtBoundary(pathname, entry.path)) continue;
    if (best === null || entry.path.length > best.path.length) best = entry;
  }
  if (best === null) return null;
  return { app: best.label, icon: best.icon };
}
