// Event + audit publishing (§4). Drive file facts go to file-meta via the frozen
// canonical envelope (payloads are the frozen minimal {driveFileId} shape). Every
// write op also emits publishAudit() — audit-log does NOT subscribe to domain
// events (design must#2). Sheet writes are audit-only (drive.sheet.written retired).
import { createEvent, publishEvent, publishAudit } from "@dub/events";
import type { DubEventEnvelope, AuditRecordEnvelopeV1 } from "@dub/events";
import { common } from "@dub/types";
import type { auditLog } from "@dub/types";
import type { Queue } from "@cloudflare/workers-types";

export interface PublishContext {
  requestId: string;
  actorId: string | null;
}

export type DriveAuditAction =
  | "drive.file.create"
  | "drive.file.move"
  | "drive.file.trash"
  | "drive.sheet.write";

export interface EventPublisher {
  fileCreated(ctx: PublishContext, driveFileId: string): Promise<void>;
  fileMoved(ctx: PublishContext, driveFileId: string): Promise<void>;
  fileTrashed(ctx: PublishContext, driveFileId: string): Promise<void>;
  audit(
    ctx: PublishContext,
    action: DriveAuditAction,
    resourceId: string,
    details?: Record<string, unknown>,
  ): Promise<void>;
}

/** Real publisher backed by the Worker's producer queue bindings. */
export function createEventPublisher(env: {
  EVT_FILE_META: Queue<DubEventEnvelope>;
  AUDIT_QUEUE: Queue<AuditRecordEnvelopeV1>;
}): EventPublisher {
  // publishEvent routes by @dub/events SUBSCRIPTIONS -> CONSUMER_QUEUE_BINDINGS;
  // drive.file.* -> "file-meta" -> binding "EVT_FILE_META".
  const publisherEnv = { EVT_FILE_META: env.EVT_FILE_META };

  async function emit(name: "drive.file.created" | "drive.file.moved" | "drive.file.trashed", ctx: PublishContext, driveFileId: string): Promise<void> {
    const event = createEvent(name, { driveFileId }, { requestId: ctx.requestId, actorId: ctx.actorId });
    await publishEvent(publisherEnv, event);
  }

  return {
    fileCreated: (ctx, id) => emit("drive.file.created", ctx, id),
    fileMoved: (ctx, id) => emit("drive.file.moved", ctx, id),
    fileTrashed: (ctx, id) => emit("drive.file.trashed", ctx, id),
    async audit(ctx, action, resourceId, details): Promise<void> {
      const input: auditLog.AuditRecordInput = {
        action,
        actorId: ctx.actorId,
        orgId: common.DUB_DEFAULT_ORG_ID,
        result: "success",
        resourceType: "drive_file",
        resourceId,
        details: details ?? null,
        requestId: ctx.requestId,
        occurredAt: new Date().toISOString(),
      };
      await publishAudit({ AUDIT_QUEUE: env.AUDIT_QUEUE }, input);
    },
  };
}
