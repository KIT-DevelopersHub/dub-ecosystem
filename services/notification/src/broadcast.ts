// Notification management — publish an admin notification to all members. An admin picks
// an audience='admin' notification (deploy done / feedback / ops alert) from the
// management screen and republishes its content as a single members-audience broadcast.
//
// A=broadcast model: we do NOT copy the row into every member's inbox eagerly. We create
// ONE notification (type=system.announcement, audience=members) fanned to all active
// users via the existing broadcast machinery — forced in_app + late-join backfill
// (repo.backfillBroadcastInbox) — so every member, including late joiners, reads the same
// single broadcast while keeping their OWN read state (one notif_inbox row per user).
// Idempotent: the dedup key links the broadcast back to its source, so re-publishing
// returns the existing broadcast id with deduplicated=true.
import type { DbClient } from "@dub/db";
import { DubError } from "@dub/errors";
import type { RequestContext } from "@dub/http";
import type { notification } from "@dub/types";
import { ingest, type IngestDeps } from "./ingest";
import type { IngestInput } from "./types";
import {
  AUDIENCE_ADMIN,
  AUDIENCE_MEMBERS,
  BROADCAST_FROM_PREFIX,
  MEMBER_BROADCAST_TYPE,
} from "./config";
import { deleteBroadcastCascade, findByDedupKey, getNotificationById } from "./repo";

/** Build the members-broadcast IngestInput derived from a source admin notification. */
export function buildBroadcastInput(
  source: { id: string; title: string; body: string | null },
  requestId: string,
  actorId: string | null,
): IngestInput {
  return {
    type: MEMBER_BROADCAST_TYPE,
    recipients: { all: true },
    title: source.title,
    body: source.body,
    priority: "normal",
    audience: AUDIENCE_MEMBERS,
    channels: ["in_app"], // forced on regardless of prefs (broadcast type)
    dedupKey: `${BROADCAST_FROM_PREFIX}${source.id}`,
    resourceType: "notification",
    resourceId: source.id,
    meta: { sourceNotificationId: source.id },
    source: "api",
    actorId,
    requestId,
  };
}

/**
 * Publish the given admin notification to all members. Throws NOTIF_NOTIFICATION_NOT_FOUND
 * (404) when the id is unknown, and NOTIF_NOT_ADMIN_AUDIENCE (409) when the source is not
 * an audience='admin' notification (only admin notifications are publishable to members).
 */
export async function publishBroadcastFromNotification(
  deps: IngestDeps,
  ctx: RequestContext,
  sourceId: string,
  actorId: string | null,
): Promise<notification.PublishBroadcastResponse> {
  const source = await getNotificationById(deps.db, sourceId);
  if (!source) {
    throw new DubError("NOTIF_NOTIFICATION_NOT_FOUND", `notification not found: ${sourceId}`, { status: 404 });
  }
  if (source.audience !== AUDIENCE_ADMIN) {
    throw new DubError(
      "NOTIF_NOT_ADMIN_AUDIENCE",
      "only admin-audience notifications can be published to members",
      { status: 409 },
    );
  }
  const result = await ingest(deps, buildBroadcastInput(source, ctx.requestId, actorId));
  return {
    notificationId: result.notificationId,
    deduplicated: result.deduplicated,
    publishedBroadcastId: result.notificationId,
  };
}

/**
 * Publish MANY admin notifications to members in one call. Each id is published
 * idempotently and INDEPENDENTLY (a not-found / non-admin id becomes a per-item failure,
 * never aborting the batch). Sequential over the shared D1 connection (no fan-out amplify)
 * — one HTTP round trip for the whole selection. Duplicate ids in the request are collapsed
 * so the same source is published at most once per call.
 */
export async function publishBroadcastBatch(
  deps: IngestDeps,
  ctx: RequestContext,
  ids: string[],
  actorId: string | null,
): Promise<notification.PublishBroadcastBatchResponse> {
  const seen = new Set<string>();
  const results: notification.PublishBroadcastBatchItem[] = [];
  let publishedCount = 0;
  let deduplicatedCount = 0;
  let failedCount = 0;

  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      const res = await publishBroadcastFromNotification(deps, ctx, id, actorId);
      results.push({ id, ok: true, deduplicated: res.deduplicated, publishedBroadcastId: res.publishedBroadcastId });
      if (res.deduplicated) deduplicatedCount++;
      else publishedCount++;
    } catch (err) {
      const code = err instanceof DubError ? err.code : "NOTIF_PUBLISH_FAILED";
      results.push({ id, ok: false, code });
      failedCount++;
    }
  }
  return { results, publishedCount, deduplicatedCount, failedCount };
}

/**
 * Unpublish (retract) the members broadcast derived from the given admin notification — the
 * inverse of publishBroadcastFromNotification. The broadcast row and every per-user inbox
 * row it fanned out are hard-deleted, so the notification disappears from all member inboxes
 * (each user's read state simply goes away with the row). The source admin notification is
 * untouched, so the management row flips back to publishable and can be re-published later.
 *
 * Idempotent: unpublishing a notification that was never published (or already retracted) is
 * a no-op with retracted=false. Validates the source like publish does — throws
 * NOTIF_NOTIFICATION_NOT_FOUND (404) for an unknown id and NOTIF_NOT_ADMIN_AUDIENCE (409)
 * when the source is not an audience='admin' notification (only those are ever published).
 */
export async function unpublishBroadcastFromNotification(
  db: DbClient,
  sourceId: string,
): Promise<notification.UnpublishBroadcastResponse> {
  const source = await getNotificationById(db, sourceId);
  if (!source) {
    throw new DubError("NOTIF_NOTIFICATION_NOT_FOUND", `notification not found: ${sourceId}`, { status: 404 });
  }
  if (source.audience !== AUDIENCE_ADMIN) {
    throw new DubError(
      "NOTIF_NOT_ADMIN_AUDIENCE",
      "only admin-audience notifications can be unpublished from members",
      { status: 409 },
    );
  }
  const broadcastId = await findByDedupKey(db, `${BROADCAST_FROM_PREFIX}${sourceId}`);
  if (!broadcastId) {
    // Never published (or already retracted) — nothing to remove.
    return { notificationId: sourceId, retracted: false, removedBroadcastId: null };
  }
  await deleteBroadcastCascade(db, broadcastId);
  return { notificationId: sourceId, retracted: true, removedBroadcastId: broadcastId };
}

/**
 * Unpublish MANY admin notifications in one call. Each id is retracted idempotently and
 * INDEPENDENTLY (an unknown / non-admin id becomes a per-item failure, never aborting the
 * batch; an already-unpublished id is a no-op success). Sequential over the shared D1
 * connection. Duplicate ids in the request are collapsed so each source is retracted once.
 */
export async function unpublishBroadcastBatch(
  db: DbClient,
  ids: string[],
): Promise<notification.UnpublishBroadcastBatchResponse> {
  const seen = new Set<string>();
  const results: notification.UnpublishBroadcastBatchItem[] = [];
  let retractedCount = 0;
  let noopCount = 0;
  let failedCount = 0;

  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      const res = await unpublishBroadcastFromNotification(db, id);
      const item: notification.UnpublishBroadcastBatchItem = { id, ok: true, retracted: res.retracted };
      if (res.removedBroadcastId) item.removedBroadcastId = res.removedBroadcastId;
      results.push(item);
      if (res.retracted) retractedCount++;
      else noopCount++;
    } catch (err) {
      const code = err instanceof DubError ? err.code : "NOTIF_UNPUBLISH_FAILED";
      results.push({ id, ok: false, code });
      failedCount++;
    }
  }
  return { results, retractedCount, noopCount, failedCount };
}
