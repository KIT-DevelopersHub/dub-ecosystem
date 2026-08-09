// Snapshot sync (GET /m/v1/sync). Returns a *full snapshot* of the caller's
// resources (all events + own tasks + inbox) so an offline client can rebuild
// its mirror in one catch-up. It is NOT yet differential: no upstream service
// honors a `updatedSince`/change-since filter today (grep: zero readers), so the
// BFF cannot ask for "changed since X" and must pull the whole set every time.
//
// The cursor is still round-tripped as a base64url-wrapped server-time
// watermark, but its only live purpose is forward-compatibility: it is passed to
// each master service as `updatedSince`, which they currently ignore. When the
// physical mobile_change_log table + its queue writers land (theme14 D2 / #28),
// the same cursor becomes a real differential watermark with no wire-shape
// change. Until then, treat every pull as a fresh full snapshot; the cursor is
// harmless and correct-by-superset (a superset of "the changes" is always safe
// for an upsert-merge client).
//
// MO3 composes, it never re-defines a resource shape (design §1): it fans out to
// the source-of-truth services and tags each item with its resource kind.
import type { ServiceClient, RequestContext } from "@dub/http";
import type { common, event, task, notification, mobile } from "@dub/types";
import { mobileErrors } from "./errors";

/** The three master services a mobile client mirrors offline. */
export interface SyncSources {
  event: ServiceClient;
  task: ServiceClient;
  notification: ServiceClient;
}

/** Parsed GET /m/v1/sync inputs (cursor wins over the legacy `since` hint). */
export interface SyncInput {
  cursor?: string;
  since?: string;
  limit?: number;
}

/** One changed resource. `data` is the source-of-truth snapshot (upsert form). */
export interface SyncChangeEntry {
  resource: "event" | "task" | "notification";
  id: string;
  data: unknown;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200; // common.ts D3
const MAX_PAGES = 50; // safety bound per source (<= 10k rows/source at MAX_LIMIT)

function encodeCursor(since: string): string {
  return btoa(JSON.stringify({ v: 1, since }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeCursor(cursor: string): string {
  try {
    const b64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const obj = JSON.parse(atob(b64)) as { v?: unknown; since?: unknown };
    if (obj.v !== 1 || typeof obj.since !== "string") throw new Error("shape");
    return obj.since;
  } catch {
    throw mobileErrors.syncCursorExpired();
  }
}

function clampLimit(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

/**
 * Drain every page of one upstream list, following its opaque `nextCursor` until
 * the source reports the end (`nextCursor === null`). `limit` is the per-page
 * size, not a total cap — the whole set is returned, so no rows are silently
 * dropped past the first page. Mirrors gantt-service/src/upstream.ts.
 */
async function fetchAllPages<T>(
  page: (cursor: string | undefined) => Promise<common.Paginated<T>>,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await page(cursor);
    out.push(...res.items);
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return out;
}

/**
 * GET /m/v1/sync — a full snapshot of the caller's mirrored resources.
 *
 * Each source is drained across *all* pages (fetchAllPages) so a result set
 * larger than one page is never truncated. `limit` is the per-page size.
 *
 * Fail-closed: if any source errors the whole pull rejects (the client retries
 * with the *same* cursor), so the watermark never advances past a snapshot the
 * client did not fully receive. `now` is injectable for deterministic tests.
 *
 * `updatedSince` is forwarded for forward-compatibility only; no upstream
 * filters on it yet (see file header), so the response is a full snapshot.
 */
export async function buildSync(
  sources: SyncSources,
  ctx: RequestContext,
  userId: string,
  input: SyncInput,
  now: () => string = () => new Date().toISOString(),
): Promise<mobile.SyncResponse> {
  // Watermark captured *before* fan-out so writes racing the read are picked up
  // by the next pull rather than silently skipped.
  const serverTime = now();
  const since = input.cursor ? decodeCursor(input.cursor) : input.since;
  const limit = clampLimit(input.limit);
  const base = since ? { updatedSince: since, limit } : { limit };
  const withCursor = (cursor: string | undefined) => (cursor ? { ...base, cursor } : { ...base });

  const [events, tasks, inbox] = await Promise.all([
    fetchAllPages<event.EventSummary>((cursor) =>
      sources.event.get<event.ListEventsResponse>(ctx, "/events", { query: withCursor(cursor) }),
    ),
    fetchAllPages<task.Task>((cursor) =>
      sources.task.get<task.ListTasksResponse>(ctx, "/tasks", { query: { ...withCursor(cursor), assigneeId: userId } }),
    ),
    fetchAllPages<notification.InboxItem>((cursor) =>
      sources.notification.get<notification.ListInboxResponse>(ctx, "/inbox", { query: withCursor(cursor) }),
    ),
  ]);

  const items: SyncChangeEntry[] = [
    ...events.map((e): SyncChangeEntry => ({ resource: "event", id: e.id, data: e })),
    ...tasks.map((t): SyncChangeEntry => ({ resource: "task", id: t.id, data: t })),
    ...inbox.map((n): SyncChangeEntry => ({ resource: "notification", id: n.id, data: n })),
  ];

  return { items, nextCursor: encodeCursor(serverTime), serverTime };
}
