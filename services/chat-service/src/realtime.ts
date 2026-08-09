// RealtimePublisher implementations.
//
// Two impls satisfy the frozen `RealtimePublisher` contract (design §2):
//   - DoRealtimePublisher: the real wiring. Forwards each ChatRealtimeEvent to the
//     per-channel ChatRoom DO stub (getByName(channelId)) via RPC. Used whenever the
//     CHAT_ROOM Durable Object namespace is bound.
//   - NoopRealtimePublisher: fallback for local/preview where no DO is bound. The
//     HTTP master stays fully functional without it — RT is a delivery optimisation,
//     not the source of truth.
import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import type { common, chat } from "@dub/types";
import { consoleSink } from "@dub/observability";
import type { RealtimePublisher } from "./types";
import type { ChatRoom } from "./chat-room-do";

export class NoopRealtimePublisher implements RealtimePublisher {
  async publishToChannel(_channelId: common.ChannelId, _event: chat.ChatRealtimeEvent): Promise<void> {
    // intentionally empty when no ChatRoom DO binding exists
  }
}

/**
 * Real RT publisher. Routes to the DO instance that owns the channel (one DO per
 * channel) and calls its `publish` RPC, which fans out to every connected socket.
 * Called AFTER the DB commit so RT never leads the source of truth.
 */
export class DoRealtimePublisher implements RealtimePublisher {
  constructor(private readonly ns: DurableObjectNamespace<ChatRoom>) {}

  async publishToChannel(channelId: common.ChannelId, event: chat.ChatRealtimeEvent): Promise<void> {
    // Best-effort: this runs AFTER the DB commit, and RT is a delivery optimisation,
    // not the source of truth. A DO fanout failure must never fail the write that
    // already succeeded — log and swallow so the caller's request stays 2xx.
    try {
      const stub = this.ns.getByName(channelId);
      await stub.publish(event);
    } catch (err) {
      consoleSink({
        level: "warn",
        message: "realtime fanout failed",
        service: "chat-service",
        fields: { channelId, kind: event.kind, err: String(err) },
      });
    }
  }
}
