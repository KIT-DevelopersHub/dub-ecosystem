// RealtimePublisher for the inbox — pushes a fresh unread count to a user's live WS
// connections the moment an in-app notification is committed, so the fe5 badge updates
// instantly instead of on the next 60s poll. Mirrors chat-service/src/realtime.ts.
//
// Two impls satisfy the `InboxRealtimePublisher` contract:
//   - DoInboxRealtimePublisher: forwards to the per-user InboxRoom DO (getByName(userId))
//     via its `publish` RPC, which fans out to every connected socket. Used when the
//     INBOX_ROOM Durable Object namespace is bound.
//   - NoopInboxRealtimePublisher: fallback for local/preview/tests where no DO is bound.
//     The HTTP master stays fully functional without it — realtime is a delivery
//     optimisation, not the source of truth (the poller still reconciles).
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { consoleSink } from "@dub/observability";
import type { InboxRoom } from "./inbox-room-do";

export interface InboxRealtimePublisher {
  /** Signal a user's live WS sockets that their inbox changed (best-effort; the client
   *  refetches the authoritative unread count in response). */
  pushInboxChanged(userId: string): Promise<void>;
}

export class NoopInboxRealtimePublisher implements InboxRealtimePublisher {
  async pushInboxChanged(_userId: string): Promise<void> {
    // intentionally empty when no InboxRoom DO binding exists
  }
}

export class DoInboxRealtimePublisher implements InboxRealtimePublisher {
  constructor(private readonly ns: DurableObjectNamespace<InboxRoom>) {}

  async pushInboxChanged(userId: string): Promise<void> {
    // Best-effort: this runs AFTER the D1 commit, and realtime is a delivery optimisation,
    // not the source of truth. A DO fanout failure must never fail the write that already
    // succeeded — log and swallow so the caller's request stays 2xx.
    try {
      const stub = this.ns.getByName(userId);
      await stub.publish({ kind: "inbox-changed" });
    } catch (err) {
      consoleSink({
        level: "warn",
        message: "inbox realtime fanout failed",
        service: "notification",
        fields: { userId, err: String(err) },
      });
    }
  }
}

/** Build the realtime publisher from the optional INBOX_ROOM namespace. */
export function buildInboxRealtime(
  ns: DurableObjectNamespace<InboxRoom> | undefined,
): InboxRealtimePublisher {
  return ns ? new DoInboxRealtimePublisher(ns) : new NoopInboxRealtimePublisher();
}
