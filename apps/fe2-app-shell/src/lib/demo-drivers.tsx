// Demo-only "liveness" drivers (VITE_DEMO builds ONLY).
//
// The demo has no backend, so two of the micro-interactions can never fire on
// their own: the 通知ベル pulse (A04, needs the unread count to *rise*) and the
// チャット新着入場 slide-up/fade-in (A05, needs a fresh inbound message). These
// drivers fabricate exactly those two events on a 30s cadence so a viewer can
// watch both animations without touching production data.
//
// EVERYTHING here is gated on the demo build: `DemoDrivers` is only mounted when
// `isDemoEnabled(import.meta.env)` (main.tsx), and `DemoChatRealtimeClient` is
// only handed to the chat runtime under the same guard (moduleProviders.tsx). A
// production bundle (VITE_DEMO unset) instantiates none of this.

import { useEffect } from "react";
import { useUnreadStore } from "@dub/fe5-notification-inbox";
import type { common } from "@dub/types";
import type { ChatRealtimeEvent } from "@dub/fe6-chat/src/api/contract";
import type { ChatRealtimeClient, RealtimeStatus } from "@dub/fe6-chat/src/realtime/client";
import { demoAddNotification } from "./demo-seed.tsx";

/** Cadence for both demo drivers — one fabricated event every 30 seconds. */
export const DEMO_TICK_MS = 30_000;

/**
 * A04 driver: every 30s, append a fresh unread notification to the demo inbox
 * (so the list + count stay coherent) and bump the shared unread store, which
 * makes the header bell badge pulse (the bell pulses only on a count *increase*).
 * Renders nothing.
 */
export function DemoDrivers(): null {
  useEffect(() => {
    const id = setInterval(() => {
      demoAddNotification();
      // Immediate optimistic bump so the pulse fires exactly on the tick rather
      // than waiting for the 60s unread poller; the poller later reconciles to
      // the same (grown) seed count, so the two never fight.
      const next = useUnreadStore.getState().count + 1;
      useUnreadStore.getState().setCount(next);
    }, DEMO_TICK_MS);
    return () => clearInterval(id);
  }, []);
  return null;
}

// Rotating cast + bodies for the fabricated chat arrivals (A05). Authors are demo
// roster ids; the timeline falls back to initials if a name can't be resolved.
const DEMO_CHAT_AUTHORS: common.UserId[] = [
  "usr_bob" as common.UserId,
  "usr_super" as common.UserId,
  "usr_member" as common.UserId,
];
const DEMO_CHAT_BODIES = [
  "会場設営の件、17時から入れそうです 🙌",
  "登壇者スライド、共有フォルダに上げました！",
  "受付の動線、もう一度だけ確認したいです",
  "スポンサー各社への連絡、完了しました ✅",
  "配信テスト、問題なく通りました！",
];

/**
 * A05 driver: a demo-only realtime client. On `connect` (a channel is opened) it
 * fabricates one inbound `message.created` for THAT channel every 30s, which the
 * timeline renders with the 新着入場 slide-up + fade-in. Implements the exact
 * `ChatRealtimeClient` interface so the chat runtime treats it like the real WS
 * transport — no UI code changes.
 */
export class DemoChatRealtimeClient implements ChatRealtimeClient {
  private eventHandlers = new Set<(e: ChatRealtimeEvent) => void>();
  private statusHandlers = new Set<(s: RealtimeStatus) => void>();
  private status: RealtimeStatus = "connecting";
  private timer: ReturnType<typeof setInterval> | null = null;
  private channelId: common.ChannelId | null = null;
  private seq = 0;

  connect(channelId: common.ChannelId): void {
    this.channelId = channelId;
    this.setStatus("open");
    this.stopTimer();
    this.timer = setInterval(() => this.fabricate(), DEMO_TICK_MS);
  }

  disconnect(): void {
    this.stopTimer();
    this.channelId = null;
    this.setStatus("closed");
  }

  onEvent(handler: (e: ChatRealtimeEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onStatusChange(handler: (s: RealtimeStatus) => void): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => this.statusHandlers.delete(handler);
  }

  private fabricate(): void {
    if (!this.channelId) return;
    const now = Date.now();
    // Monotonic, lexically-increasing id so it sorts to the tail of the timeline
    // (the tail-arrival is what triggers the A05 entering animation).
    const messageId = `msg_demo_${now}_${this.seq}` as common.MessageId;
    const author = DEMO_CHAT_AUTHORS[this.seq % DEMO_CHAT_AUTHORS.length]!;
    const body = DEMO_CHAT_BODIES[this.seq % DEMO_CHAT_BODIES.length]!;
    this.seq += 1;
    const event: ChatRealtimeEvent = {
      kind: "message.created",
      channelId: this.channelId,
      messageId,
      authorId: author,
      body,
      at: new Date(now).toISOString() as common.ISODateTime,
    };
    for (const h of this.eventHandlers) h(event);
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private setStatus(s: RealtimeStatus): void {
    this.status = s;
    for (const h of this.statusHandlers) h(s);
  }
}
