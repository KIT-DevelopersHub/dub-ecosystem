// RealtimePublisher implementations.
//
// P0 wires the NO-OP: the real chat-owned ChatRoom DO (WS fanout / presence /
// ws-ticket verify) is a SEPARATE Worker whose Service Binding / DO stub is added
// in the integration wave (9-C activation). The HTTP master stays fully functional
// without it — RT is a delivery optimisation, not the source of truth.
import type { common, chat } from "@dub/types";
import type { RealtimePublisher } from "./types";

export class NoopRealtimePublisher implements RealtimePublisher {
  async publishToChannel(_channelId: common.ChannelId, _event: chat.ChatRealtimeEvent): Promise<void> {
    // intentionally empty until the ChatRoom DO binding exists
  }
}

// Future: DoRealtimePublisher wraps env.CHAT_ROOM (DurableObjectNamespace) and
// forwards ChatRealtimeEvent to the per-channel DO stub (idFromName(channelId)).
