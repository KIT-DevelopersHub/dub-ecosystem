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
import { getNotificationById } from "./repo";

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
