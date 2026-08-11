// Differential-sync change-log construction for MO3. The queue consumer
// (dub-q-evt-mobile-bff) subscribes to task.*/event.*/action.* (theme1) and appends
// one ordered row per event to mobile_change_log. Mobile clients then pull rows after
// their last seq for offline differential sync. This module holds the pure
// event -> entry mapping (testable with no runtime), the D1-backed append store, and
// the consumer factory. queue.ts wires this to the Worker's DB_MOBILE binding.
import type { MessageBatch } from "@cloudflare/workers-types";
import { type DbClient, nowIso } from "@dub/db";
import {
  createQueueHandler,
  type DubEventEnvelope,
  type DubEventName,
  type DubEventHandlerMap,
  type QueueHandlerOptions,
} from "@dub/events";

export type ChangeEntityType = "event" | "action" | "task";
export type ChangeOp = "upsert" | "delete";

/** One append-only row of the differential-sync feed (pre-seq; seq is DB-assigned). */
export interface ChangeLogEntry {
  eventId: string; // envelope.id (ULID) — idempotency key (UNIQUE in the table)
  eventName: DubEventName;
  entityType: ChangeEntityType;
  entityId: string; // the task/event/action id the change applies to
  op: ChangeOp; // "archived" verbs -> delete; everything else -> upsert
  actorId: string | null;
  occurredAt: string; // envelope.occurredAt (ISO 8601)
  payloadJson: string; // JSON.stringify(envelope.payload) — the raw diff for the client
}

// task.*/event.*/action.* names MO3 subscribes to (theme1 SUBSCRIPTIONS). Registering
// an explicit list keeps the consumer's surface auditable; anything else is ACKed as
// an unknown event (forward-compat) rather than silently mapped.
export const MOBILE_CHANGE_LOG_EVENTS: readonly DubEventName[] = [
  "event.created",
  "event.updated",
  "event.phase_changed",
  "event.archived",
  "action.created",
  "action.updated",
  "action.status_changed",
  "action.archived",
  "task.created",
  "task.updated",
  "task.assigned",
  "task.status_changed",
  "task.due_soon",
  "task.archived",
];

// Which payload field carries the primary entity id, per domain.
const ID_KEY: Record<ChangeEntityType, string> = {
  event: "eventId",
  action: "actionId",
  task: "taskId",
};

/**
 * Pure event -> change-log-entry mapping. Returns null when the envelope is not a
 * task/event/action change or is missing its entity id (defensive: a malformed
 * envelope is skipped, not appended as a garbage row).
 */
export function changeLogEntryFromEvent(env: DubEventEnvelope): ChangeLogEntry | null {
  const dot = env.name.indexOf(".");
  if (dot < 0) return null;
  const domain = env.name.slice(0, dot);
  const verb = env.name.slice(dot + 1);
  if (domain !== "event" && domain !== "action" && domain !== "task") return null;
  const entityType: ChangeEntityType = domain;

  const payload = env.payload as unknown as Record<string, unknown> | null | undefined;
  const entityId = payload?.[ID_KEY[entityType]];
  if (typeof entityId !== "string" || entityId.length === 0) return null;

  return {
    eventId: env.id,
    eventName: env.name,
    entityType,
    entityId,
    op: verb === "archived" ? "delete" : "upsert",
    actorId: env.actorId,
    occurredAt: env.occurredAt,
    payloadJson: JSON.stringify(env.payload),
  };
}

/** One delete tombstone from the feed: the offline client removes this entity. */
export interface DeleteTombstone {
  seq: number;
  entityType: ChangeEntityType;
  entityId: string;
}

/**
 * Read seam for differential sync. sync.ts uses it to (a) learn the current head
 * seq (the watermark it stamps into the next cursor) and (b) pull delete
 * tombstones since the client's last seq so deletions propagate — a full snapshot
 * only returns live rows, so without this an offline client never learns a
 * resource was removed. Upserts are intentionally NOT read here: the live snapshot
 * already carries their current data, so only deletions need the change_log.
 */
export interface ChangeLogReader {
  /** Highest assigned seq (0 when the feed is empty). */
  headSeq(): Promise<number>;
  /** Delete tombstones in (afterSeq, upToSeq], ascending by seq. */
  deletesSince(afterSeq: number, upToSeq: number): Promise<DeleteTombstone[]>;
}

/** D1-backed reader (mobile namespace). Reads only mobile_change_log. */
export class D1ChangeLogReader implements ChangeLogReader {
  constructor(private readonly db: DbClient) {}

  async headSeq(): Promise<number> {
    const row = await this.db.first<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM mobile_change_log");
    return row?.seq ?? 0;
  }

  async deletesSince(afterSeq: number, upToSeq: number): Promise<DeleteTombstone[]> {
    // Half-open lower / closed upper bound: (afterSeq, upToSeq]. An empty window
    // (a fresh pull with nothing new) short-circuits without touching D1.
    if (!Number.isFinite(upToSeq) || upToSeq <= afterSeq) return [];
    const rows = await this.db.all<{ seq: number; entity_type: string; entity_id: string }>(
      "SELECT seq, entity_type, entity_id FROM mobile_change_log " +
        "WHERE op = 'delete' AND seq > ? AND seq <= ? ORDER BY seq ASC",
      afterSeq,
      upToSeq,
    );
    return rows.map((r) => ({ seq: r.seq, entityType: r.entity_type as ChangeEntityType, entityId: r.entity_id }));
  }
}

/** Append seam so the consumer can be tested without a D1 runtime. */
export interface ChangeLogStore {
  append(entry: ChangeLogEntry): Promise<void>;
}

/** D1-backed append store (mobile namespace). Idempotent on event_id. */
export class D1ChangeLogStore implements ChangeLogStore {
  constructor(private readonly db: DbClient) {}

  async append(entry: ChangeLogEntry): Promise<void> {
    // seq is AUTOINCREMENT (monotonic pull cursor). ON CONFLICT keeps the first row,
    // so a redelivered envelope (same ULID) does not double-append — the feed stays
    // exactly-once per event even though the queue is at-least-once.
    await this.db.run(
      "INSERT INTO mobile_change_log " +
        "(event_id, event_name, entity_type, entity_id, op, actor_id, occurred_at, payload_json, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (event_id) DO NOTHING",
      entry.eventId,
      entry.eventName,
      entry.entityType,
      entry.entityId,
      entry.op,
      entry.actorId,
      entry.occurredAt,
      entry.payloadJson,
      nowIso(),
    );
  }
}

// Set form of the subscribed names — cheap membership test for the HTTP landing route.
const SUBSCRIBED_EVENTS = new Set<string>(MOBILE_CHANGE_LOG_EVENTS);

/**
 * The single append path shared by BOTH lanes — the paid Queue consumer
 * (dub-q-evt-mobile-bff, via buildChangeLogHandlers) and the free-tier HTTP landing
 * route (POST /internal/events-async). A name outside the subscribed set is ACKed as an
 * unknown event (forward-compat) — never appended as a garbage row. Append is idempotent
 * on event_id (ON CONFLICT DO NOTHING), so an at-least-once redelivery from either lane
 * does not double-append. Returns whether a row was appended (for the endpoint's body).
 */
export async function ingestChangeLogEvent(store: ChangeLogStore, env: DubEventEnvelope): Promise<boolean> {
  if (!SUBSCRIBED_EVENTS.has(env.name)) return false; // unknown -> ack (no append)
  const entry = changeLogEntryFromEvent(env);
  if (!entry) return false;
  await store.append(entry);
  return true;
}

/** Build the handler map that appends a change-log row per subscribed event. */
export function buildChangeLogHandlers(store: ChangeLogStore): DubEventHandlerMap {
  const handlers: Record<string, (env: DubEventEnvelope) => Promise<void>> = {};
  const append = async (env: DubEventEnvelope): Promise<void> => {
    await ingestChangeLogEvent(store, env);
  };
  for (const name of MOBILE_CHANGE_LOG_EVENTS) handlers[name] = append;
  return handlers as DubEventHandlerMap;
}

/**
 * Consumer for dub-q-evt-mobile-bff: appends the differential-sync change_log from
 * task / event / action events. Unknown events are ACKed (forward-compat); handler
 * failures are retried (max_retries -> DLQ per wrangler config) via @dub/events.
 */
export function createChangeLogConsumer(
  store: ChangeLogStore,
  opts: QueueHandlerOptions = {},
): (batch: MessageBatch<DubEventEnvelope>, env: unknown) => Promise<void> {
  return createQueueHandler(buildChangeLogHandlers(store), {
    service: "mobile-bff",
    onUnknownEvent: "ack",
    ...opts,
  });
}
