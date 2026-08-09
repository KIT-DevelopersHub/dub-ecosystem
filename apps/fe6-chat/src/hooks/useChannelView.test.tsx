import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { ChatRuntimeProvider, type ChatRuntime } from "../context";
import { useChannelView } from "./useChannelView";
import { MockChatClient } from "../api/mock-client";
import { MockRealtimeClient } from "../realtime/mock-client";
import { demoSeed, ME, OTHER } from "../dev/seed";
import { useChatStore } from "../store/useChatStore";

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
