// Differential sync (GET /m/v1/sync). Returns everything the caller's resources
// changed *since* an opaque cursor, so an offline client can catch up with one
// call. The cursor is a base64url-wrapped server-time watermark: the BFF stamps
// "now" at the start of a pull and, on the next pull, forwards it to each master
// service as `updatedSince`. A single cross-service watermark keeps the diff
// consistent even though the upstream cursors are per-service and opaque
// (design §1 — MO3 composes, it never re-defines a resource shape).
//
// This is the read side of the offline wave (theme14 D2). The physical
// mobile_change_log table + its queue writers land with #28 / the sync wave; the
// BFF read model here fans out to the source-of-truth services directly, so it is
// correct without a local change_log and forward-compatible with one.
import type { ServiceClient, RequestContext } from "@dub/http";
import { DubError } from "@dub/errors";
import type { event, task, notification, mobile } from "@dub/types";

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

/** 400 — cursor is unparseable (tampered) or from an incompatible version. */
function syncCursorExpired(): DubError {
  return new DubError("MOBILE_SYNC_CURSOR_EXPIRED", "sync cursor is invalid or expired", {
    status: 400,
    retryable: false,
  });
}

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
    throw syncCursorExpired();
  }
}

function clampLimit(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

/**
 * GET /m/v1/sync — the resources changed since the cursor watermark.
 *
 * Fail-closed: if any source errors the whole pull rejects (the client retries
 * with the *same* cursor), so the watermark never advances past changes the
 * client did not receive. `now` is injectable for deterministic tests.
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
  const q = since ? { updatedSince: since, limit } : { limit };

  const [events, tasks, inbox] = await Promise.all([
    sources.event.get<event.ListEventsResponse>(ctx, "/events", { query: q }),
    sources.task.get<task.ListTasksResponse>(ctx, "/tasks", { query: { ...q, assigneeId: userId } }),
    sources.notification.get<notification.ListInboxResponse>(ctx, "/inbox", { query: q }),
  ]);

  const items: SyncChangeEntry[] = [
    ...events.items.map((e): SyncChangeEntry => ({ resource: "event", id: e.id, data: e })),
    ...tasks.items.map((t): SyncChangeEntry => ({ resource: "task", id: t.id, data: t })),
    ...inbox.items.map((n): SyncChangeEntry => ({ resource: "notification", id: n.id, data: n })),
  ];

  return { items, nextCursor: encodeCursor(serverTime), serverTime };
}
