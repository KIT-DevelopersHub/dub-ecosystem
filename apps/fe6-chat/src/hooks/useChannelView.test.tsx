import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { common } from "@dub/types";
import { ChatRuntimeProvider, type ChatRuntime } from "../context";
import { useChannelView } from "./useChannelView";
import { MockChatClient } from "../api/mock-client";
import { MockRealtimeClient } from "../realtime/mock-client";
import type { ChatRealtimeClient, RealtimeStatus } from "../realtime/client";
import type { ChatRealtimeEvent, WsTicketResponse } from "../api/contract";
import { demoSeed, ME, OTHER } from "../dev/seed";
import { useChatStore } from "../store/useChatStore";

// A realtime client that never reaches "open" — models the DO-direct WS being
// unreachable (bad host / rejected ticket). Used to exercise the polling fallback.
class NeverOpenRealtimeClient implements ChatRealtimeClient {
  private statusHandlers = new Set<(s: RealtimeStatus) => void>();
  connect(_channelId: common.ChannelId, _ticket: WsTicketResponse): void {
    for (const h of this.statusHandlers) h("reconnecting");
  }
  disconnect(): void {
    for (const h of this.statusHandlers) h("closed");
  }
  onEvent(_handler: (e: ChatRealtimeEvent) => void): () => void {
    return () => undefined;
  }
  onStatusChange(handler: (s: RealtimeStatus) => void): () => void {
    this.statusHandlers.add(handler);
    handler("connecting");
    return () => this.statusHandlers.delete(handler);
  }
}

const GENERAL = "chn_general00000000000000000";

function makeRuntime() {
  const api = new MockChatClient(demoSeed());
  const rt = new MockRealtimeClient();
  const runtime: ChatRuntime = {
    api,
    currentUserId: ME,
    can: () => true,
    createRealtimeClient: () => rt,
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ChatRuntimeProvider value={runtime}>{children}</ChatRuntimeProvider>
  );
  return { api, rt, wrapper };
}

describe("useChannelView integration", () => {
  beforeEach(() => {
    useChatStore.setState({ unread: {}, activeChannelId: null });
  });

  it("loads the initial history page", async () => {
    const { wrapper } = makeRuntime();
    const { result } = renderHook(() => useChannelView(GENERAL), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.state.messages.length).toBeGreaterThan(0);
  });

  it("optimistically shows a pending message then acks it to a real ULID", async () => {
    const { wrapper } = makeRuntime();
    const { result } = renderHook(() => useChannelView(GENERAL), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.send("hello from test");
    });

    expect(result.current.state.pending).toHaveLength(0);
    const bodies = result.current.state.messages.map((m) => m.body);
    expect(bodies).toContain("hello from test");
    const posted = result.current.state.messages.find((m) => m.body === "hello from test")!;
    expect(posted.id.startsWith("msg_")).toBe(true);
    expect(posted.authorId).toBe(ME);
  });

  it("marks a message failed on error, keeping it for resend", async () => {
    const { api, wrapper } = makeRuntime();
    const { result } = renderHook(() => useChannelView(GENERAL), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const { ChatApiError } = await import("../api/client");
    api.nextError = new ChatApiError(429, { error: { code: "RATE_LIMITED", message: "slow", retryable: true } });

    await act(async () => {
      await result.current.send("will fail").catch(() => undefined);
    });

    expect(result.current.state.pending).toHaveLength(1);
    expect(result.current.state.pending[0]!.state).toBe("failed");

    // resend now succeeds
    await act(async () => {
      await result.current.resend(result.current.state.pending[0]!.clientTempId);
    });
    expect(result.current.state.pending).toHaveLength(0);
    expect(result.current.state.messages.some((m) => m.body === "will fail")).toBe(true);
  });

  it("applies a realtime message.created from another user with no interaction", async () => {
    const { rt, wrapper } = makeRuntime();
    const { result } = renderHook(() => useChannelView(GENERAL), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    // RT connects during the mount effect; wait until open
    await waitFor(() => expect(result.current.state.rtStatus).toBe("open"));

    const before = result.current.state.messages.length;
    act(() => {
      rt.emit({
        kind: "message.created",
        channelId: GENERAL,
        messageId: "msg_zzzzzzzzzzzzzzzzzzzzzzzzz",
        authorId: OTHER,
        body: "live message",
        at: "2026-08-09T05:00:00Z",
      });
    });
    expect(result.current.state.messages.length).toBe(before + 1);
    expect(result.current.state.messages.some((m) => m.body === "live message")).toBe(true);
  });

  it("falls back to polling when the WS never opens: a server-side message appears without RT", async () => {
    vi.useFakeTimers();
    try {
      const api = new MockChatClient(demoSeed());
      const runtime: ChatRuntime = {
        api,
        currentUserId: ME,
        can: () => true,
        createRealtimeClient: () => new NeverOpenRealtimeClient(),
      };
      const wrapper = ({ children }: { children: ReactNode }) => (
        <ChatRuntimeProvider value={runtime}>{children}</ChatRuntimeProvider>
      );
      const { result } = renderHook(() => useChannelView(GENERAL), { wrapper });
      await vi.waitFor(() => expect(result.current.loading).toBe(false));
      // WS is stuck off the happy path — never "open".
      expect(result.current.state.rtStatus).not.toBe("open");

      // Another client posts to the same channel (server-side only; not via the hook).
      await act(async () => {
        await api.postMessage({ channelId: GENERAL, body: "arrived via poll", clientTempId: "x" });
      });
      // Nothing yet — the hook has not been told.
      expect(result.current.state.messages.some((m) => m.body === "arrived via poll")).toBe(false);

      // One poll cycle later, the fallback pulls it into the timeline.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(result.current.state.messages.some((m) => m.body === "arrived via poll")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("optimistically removes a message the instant delete is called, before the DELETE resolves (hard)", async () => {
    const { api, wrapper } = makeRuntime();
    const { result } = renderHook(() => useChannelView(GENERAL), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const target = result.current.state.messages[result.current.state.messages.length - 1]!;
    api.latencyMs = 60; // delay the server ack so we can observe the optimistic state

    let p: Promise<void>;
    act(() => {
      p = result.current.deleteMessage(target.id, target.version);
    });
    // Immediately gone — no waiting on the network (default policy = hard).
    expect(result.current.state.messages.some((m) => m.id === target.id)).toBe(false);

    await act(async () => {
      await p!;
    });
    // Stays gone after the server confirms (reconcile agrees).
    expect(result.current.state.messages.some((m) => m.id === target.id)).toBe(false);
  });

  it("rolls back the optimistic delete on failure so the message reappears, and rejects", async () => {
    const { api, wrapper } = makeRuntime();
    const { result } = renderHook(() => useChannelView(GENERAL), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const target = result.current.state.messages[result.current.state.messages.length - 1]!;
    const { ChatApiError } = await import("../api/client");
    api.nextError = new ChatApiError(500, { error: { code: "INTERNAL", message: "boom", retryable: false } });

    let rejected = false;
    await act(async () => {
      await result.current.deleteMessage(target.id, target.version).catch(() => {
        rejected = true;
      });
    });

    expect(rejected).toBe(true); // caller can surface an error toast
    // Rolled back: the message is back in the timeline.
    expect(result.current.state.messages.some((m) => m.id === target.id)).toBe(true);
  });

  it("optimistically toggles a reaction and reconciles with the server", async () => {
    const { wrapper } = makeRuntime();
    const { result } = renderHook(() => useChannelView(GENERAL), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    const target = result.current.state.messages[0]!;
    await act(async () => {
      await result.current.toggleReaction(target.id, "🎉");
    });
    const updated = result.current.state.messages.find((m) => m.id === target.id)!;
    const reaction = updated.reactions.find((r) => r.emoji === "🎉");
    expect(reaction?.userIds).toContain(ME);
  });
});
