// RealtimePublisher implementations. 写経 of chat-service/src/realtime.ts.
//
// Two impls satisfy the RealtimePublisher contract:
//   - DoRealtimePublisher: the real wiring. Routes each GanttRealtimeEvent to the
//     per-event GanttRoom DO stub (getByName(eventId)) via RPC. Used whenever the
//     GANTT_ROOM Durable Object namespace is bound.
//   - NoopRealtimePublisher: fallback for local/preview where no DO is bound. The HTTP
//     read model stays fully functional without it — RT is a delivery optimisation, not
//     the source of truth.
//
// Delta-only fanout (コスト最小化 / 判断66): `publishRowMoved` ships just the moved bar's
// window (high-frequency drag path → no whole-chart re-send); `publishInvalidated` ships
// a tiny hint (low-frequency structural change → clients debounce-refetch once).
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { common, gantt } from "@dub/types";
import { consoleSink } from "@dub/observability";
import type { GanttRoom } from "./gantt-room-do";

export interface RealtimePublisher {
  /** A bar's window changed (drag/resize/date edit). Delta-only: clients apply it
   *  straight to their cache, no refetch. */
  publishRowMoved(
    eventId: common.EventId,
    move: { taskId: common.TaskId; startsAt: common.ISODateTime | null; endsAt: common.ISODateTime | null },
  ): Promise<void>;
  /** A structural change (create/delete/status/assignee/dependency/archive) landed;
   *  the derived chart may have shifted. Ships a hint so clients refetch fresh once. */
  publishInvalidated(eventId: common.EventId, reason: string): Promise<void>;
}

export class NoopRealtimePublisher implements RealtimePublisher {
  async publishRowMoved(): Promise<void> {
    // intentionally empty when no GanttRoom DO binding exists
  }
  async publishInvalidated(): Promise<void> {
    // intentionally empty when no GanttRoom DO binding exists
  }
}

/**
 * Real RT publisher. Routes to the DO instance that owns the event (one DO per event)
 * and calls its `publish` RPC, which fans out to every connected socket. Called AFTER
 * the write commits so RT never leads the source of truth.
 */
export class DoRealtimePublisher implements RealtimePublisher {
  constructor(private readonly ns: DurableObjectNamespace<GanttRoom>) {}

  async publishRowMoved(
    eventId: common.EventId,
    move: { taskId: common.TaskId; startsAt: common.ISODateTime | null; endsAt: common.ISODateTime | null },
  ): Promise<void> {
    await this.fanout(eventId, {
      kind: "row.moved",
      eventId,
      taskId: move.taskId,
      startsAt: move.startsAt,
      endsAt: move.endsAt,
      at: new Date().toISOString(),
    });
  }

  async publishInvalidated(eventId: common.EventId, reason: string): Promise<void> {
    await this.fanout(eventId, {
      kind: "chart.invalidated",
      eventId,
      reason,
      at: new Date().toISOString(),
    });
  }

  private async fanout(eventId: common.EventId, event: gantt.GanttRealtimeEvent): Promise<void> {
    // Best-effort: this runs AFTER the write commit, and RT is a delivery optimisation,
    // not the source of truth. A DO fanout failure must never fail the write that already
    // succeeded — log and swallow so the caller's request stays 2xx.
    try {
      const stub = this.ns.getByName(eventId);
      await stub.publish(event);
    } catch (err) {
      consoleSink({
        level: "warn",
        message: "gantt realtime fanout failed",
        service: "gantt-service",
        fields: { eventId, kind: event.kind, err: String(err) },
      });
    }
  }
}

/** Build the publisher from the env: real DO fanout when GANTT_ROOM is bound, else Noop. */
export function buildRealtime(ns: DurableObjectNamespace<GanttRoom> | undefined): RealtimePublisher {
  return ns ? new DoRealtimePublisher(ns) : new NoopRealtimePublisher();
}
