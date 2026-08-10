// Snapshot sync (GET /m/v1/sync). Returns the caller's mirrored resources so an
// offline client can rebuild in one catch-up. Upserts come from a *full snapshot*
// fan-out (no upstream honors a change-since filter yet — grep: zero readers — so
// the BFF still pulls the whole live set); a superset of the changes is always
// safe for an upsert-merge client.
//
// Deletions are the half that a snapshot cannot express: a full snapshot returns
// only *live* rows, so an offline client would never learn a resource was removed.
// So on an incremental pull we also drain delete tombstones from mobile_change_log
// (the dub-q-evt-mobile-bff feed, change-log.ts) and emit them as op:"delete"
// entries. The cursor therefore carries a real differential watermark — the
// change_log head `seq` — not just a cosmetic timestamp: the next pull asks for
// tombstones after that seq. `since` is still round-tripped and forwarded as
// `updatedSince` for forward-compat (when upstreams honor it, upserts become
// differential too with no wire-shape change).
//
// MO3 composes, it never re-defines a resource shape (design §1): it fans out to
// the source-of-truth services and tags each item with its resource kind.
import type { ServiceClient, RequestContext } from "@dub/http";
import type { common, event, task, notification, mobile } from "@dub/types";
import type { ChangeLogReader } from "./change-log";
import { mobileErrors } from "./errors";

/** The three master services a mobile client mirrors offline, plus the delete feed. */
export interface SyncSources {
  event: ServiceClient;
  task: ServiceClient;
  notification: ServiceClient;
  /** Differential delete feed. Optional: absent -> upsert-only snapshot (legacy). */
  changeLog?: ChangeLogReader;
}

/** Parsed GET /m/v1/sync inputs (cursor wins over the legacy `since` hint). */
export interface SyncInput {
  cursor?: string;
  since?: string;
  limit?: number;
}

/**
 * One changed resource. `data` is the source-of-truth snapshot for an upsert;
 * `op:"delete"` marks a tombstone (data is null — the client removes `id`). `op`
 * is omitted on upserts (absence == upsert) so the wire shape stays backward
 * compatible with clients that predate tombstones.
 */
export interface SyncChangeEntry {
  resource: "event" | "task" | "notification";
  id: string;
  data: unknown;
  op?: "delete";
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200; // common.ts D3
const MAX_PAGES = 50; // safety bound per source (<= 10k rows/source at MAX_LIMIT)

/** The decoded cursor: a server-time hint (`since`) + the change_log watermark. */
interface CursorState {
  since?: string;
  seq: number;
}

function encodeCursor(state: CursorState): string {
  return btoa(JSON.stringify({ v: 2, since: state.since, seq: state.seq }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeCursor(cursor: string): CursorState {
  try {
    const b64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const obj = JSON.parse(atob(b64)) as { v?: unknown; since?: unknown; seq?: unknown };
    // v1 (since-only) cursors are still accepted: seq defaults to 0, i.e. replay
    // every tombstone once — a superset that is safe for the first upgraded pull.
    if (obj.v === 1) {
      if (typeof obj.since !== "string") throw new Error("shape");
      return { since: obj.since, seq: 0 };
    }
    if (obj.v !== 2) throw new Error("version");
    const since = obj.since === undefined ? undefined : (obj.since as string);
    if (since !== undefined && typeof since !== "string") throw new Error("shape");
    const seq = typeof obj.seq === "number" && Number.isFinite(obj.seq) && obj.seq >= 0 ? obj.seq : 0;
    return { since, seq };
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
 * filters on it yet (see file header), so the upsert half is a full snapshot.
 * Deletions ARE differential: tombstones since the cursor's seq are appended.
 */
export async function buildSync(
  sources: SyncSources,
  ctx: RequestContext,
  userId: string,
  input: SyncInput,
  now: () => string = () => new Date().toISOString(),
): Promise<mobile.SyncResponse> {
  // Watermarks captured *before* fan-out so writes racing the read are picked up
  // by the next pull rather than silently skipped: serverTime for `since`, and the
  // change_log head seq for the delete feed. A tombstone that lands during the
  // fan-out gets seq > headSeq, so it is excluded now and delivered next pull
  // (nextCursor stamps headSeq) — monotonic, never lost.
  const serverTime = now();
  const prev = input.cursor ? decodeCursor(input.cursor) : undefined;
  const since = prev?.since ?? input.since;
  const fromSeq = prev?.seq ?? 0;
  const headSeq = sources.changeLog ? await sources.changeLog.headSeq() : 0;
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

  // Delete tombstones. Only on an incremental pull (a first pull with no cursor
  // rebuilds the whole mirror from live rows, so a deleted resource is simply
  // absent — no tombstone needed). A resource that was deleted then re-created
  // (archive -> un-archive) reappears in the live snapshot, so we suppress its
  // tombstone: the upsert wins and the client keeps the row.
  if (sources.changeLog && input.cursor && headSeq > fromSeq) {
    const liveEvents = new Set(events.map((e) => e.id));
    const liveTasks = new Set(tasks.map((t) => t.id));
    const tombstones = await sources.changeLog.deletesSince(fromSeq, headSeq);
    for (const t of tombstones) {
      // The base sync mirror is events + own tasks + inbox; action tombstones are
      // not mirrored here (actions ride the event-overview surface), so skip them.
      if (t.entityType === "event" && !liveEvents.has(t.entityId)) {
        items.push({ resource: "event", id: t.entityId, data: null, op: "delete" });
      } else if (t.entityType === "task" && !liveTasks.has(t.entityId)) {
        items.push({ resource: "task", id: t.entityId, data: null, op: "delete" });
      }
    }
  }

  return { items, nextCursor: encodeCursor({ since: serverTime, seq: headSeq }), serverTime };
}
