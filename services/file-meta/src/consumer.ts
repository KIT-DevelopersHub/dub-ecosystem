// file-meta Queue consumer (binding EVT_FILE_META). Subscribes to drive.* (auto meta
// registration/reflection) and *.archived (search-exposure suppression, links kept).
// All handlers are idempotent: unique(drive_file_id) + IdempotencyStore(envelope.id).
import { createQueueHandler, type DubEventEnvelope, type IdempotencyStore } from "@dub/events";
import { newId, nowIso } from "@dub/db";
import type { DriveClient, EmitEvent, FileRepo } from "./deps";

export interface ConsumerDeps {
  repo: FileRepo;
  emit: EmitEvent;
  drive?: DriveClient;
  idempotency?: IdempotencyStore;
  onUnknownLog?: (name: string) => void;
}

// System actor for events with no human origin (cron/webhook-driven).
const SYSTEM_ACTOR = null;

export function createConsumer(deps: ConsumerDeps) {
  const { repo, emit, drive } = deps;

  const emitCtx = (env: DubEventEnvelope) => ({ requestId: env.requestId, actorId: SYSTEM_ACTOR });

  return createQueueHandler(
    {
      "drive.file.created": async (env) => {
        const driveFileId = env.payload.driveFileId;
        if (await repo.getByDriveFileId(driveFileId)) return; // idempotent
        const meta = drive ? await drive.getFile(driveFileId).catch(() => null) : null;
        const now = nowIso();
        const file = await repo.createFile({
          id: newId("file"),
          name: meta?.name ?? driveFileId,
          mimeType: meta?.mimeType ?? "application/octet-stream",
          sizeBytes: 0,
          ownerId: "system",
          visibility: "org",
          driveFileId,
          r2Key: null,
          createdBy: "system",
          createdAt: now,
          updatedAt: now,
        });
        await emit("file.registered", { fileId: file.id }, emitCtx(env));
      },

      "drive.file.moved": async (env) => {
        const existing = await repo.getByDriveFileId(env.payload.driveFileId);
        if (!existing || existing.archivedAt) return; // no-op if unknown/deleted
        if (!drive) return; // name/parent reflection needs drive-proxy completion
        const meta = await drive.getFile(env.payload.driveFileId).catch(() => null);
        if (!meta || meta.name === existing.name) return;
        await repo.updateFile(existing.id, { name: meta.name }, nowIso());
        await emit("file.updated", { fileId: existing.id }, emitCtx(env));
      },

      "drive.file.trashed": async (env) => {
        const existing = await repo.getByDriveFileId(env.payload.driveFileId);
        if (!existing || existing.archivedAt) return; // idempotent
        await repo.softDeleteByDriveFileId(env.payload.driveFileId, nowIso());
        await emit("file.deleted", { fileId: existing.id }, emitCtx(env));
      },

      // *.archived: suppress the entity's links from search; keep rows (audit value).
      "event.archived": async (env) => {
        await repo.suppressLinksByTarget("event", env.payload.eventId, nowIso());
      },
      "action.archived": async (env) => {
        await repo.suppressLinksByTarget("action", env.payload.actionId, nowIso());
      },
      "task.archived": async (env) => {
        await repo.suppressLinksByTarget("task", env.payload.taskId, nowIso());
      },
    },
    {
      ...(deps.idempotency ? { idempotency: deps.idempotency } : {}),
      onUnknownEvent: "ack",
      ...(deps.onUnknownLog ? { onUnknownLog: deps.onUnknownLog } : {}),
    },
  );
}

// Outcome of processing a single envelope through the shared handler map.
// "ack" = handled (or idempotently skipped / unknown-acked); "retry" = failed, the
// caller MUST keep the source durable (its outbox row stays pending) so nothing is lost.
export type EnvelopeOutcome = "ack" | "retry";

/**
 * Transport-agnostic single-envelope entry point over the EXACT SAME handler map the
 * Queue consumer uses (idempotency, drive.* / *.archived dispatch, unknown-event ack,
 * error -> retry). It drives `createConsumer` with a synthetic one-message batch so the
 * behaviour cannot drift from the Queue path. This backs the free-tier HTTP landing
 * route POST /internal/events-async: producers (drive-proxy / event / task) that
 * deferred `evt.file-meta` rows in their own freeq outbox drain them here, closing the
 * loop without a paid Queue. No cycle is re-introduced: the handlers emit file.* events
 * which have no subscribers, so processing an inbound event never re-enqueues to
 * file-meta.
 */
export function createEnvelopeConsumer(deps: ConsumerDeps): (env: DubEventEnvelope) => Promise<EnvelopeOutcome> {
  const batchHandler = createConsumer(deps);
  return async (env) => {
    let outcome: EnvelopeOutcome = "ack";
    const message = {
      id: (env && typeof env.id === "string" ? env.id : "0"),
      timestamp: new Date(),
      attempts: 1,
      body: env,
      ack() {
        outcome = "ack";
      },
      retry() {
        outcome = "retry";
      },
    };
    const batch = { messages: [message], queue: "internal-events-async", ackAll() {}, retryAll() {} };
    await batchHandler(batch as unknown as never, {});
    return outcome;
  };
}
