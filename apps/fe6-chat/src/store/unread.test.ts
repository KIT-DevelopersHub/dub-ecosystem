import { describe, it, expect } from "vitest";
import type { ChatRealtimeEvent } from "../api/contract";
import { applyUnreadEvent, clearUnread, toUnreadMap, unreadTotal } from "./unread";

const ME = "usr_me";
const OTHER = "usr_other";
const created = (channelId: string, body: string, authorId = OTHER): ChatRealtimeEvent => ({
  kind: "message.created",
  channelId,
  messageId: "msg_x",
  authorId,
  body,
  at: "2026-08-09T01:00:00Z",
});

describe("unread aggregation", () => {
  it("sums totals across channels", () => {
    const map = toUnreadMap([
      { channelId: "a", unreadCount: 2, lastReadMessageId: null, mentioned: false },
      { channelId: "b", unreadCount: 3, lastReadMessageId: null, mentioned: true },
    ]);
    expect(unreadTotal(map)).toBe(5);
  });

  it("increments unread for a non-active channel", () => {
    const map = applyUnreadEvent({}, created("b", "hi"), "a", ME);
    expect(map["b"]!.unreadCount).toBe(1);
  });

  it("does not increment the active channel", () => {
    const map = applyUnreadEvent({}, created("a", "hi"), "a", ME);
    expect(map["a"]).toBeUndefined();
  });

  it("does not count my own messages", () => {
    const map = applyUnreadEvent({}, created("b", "hi", ME), "a", ME);
    expect(map["b"]).toBeUndefined();
  });

  it("flags mention when the body @-mentions me", () => {
    const map = applyUnreadEvent({}, created("b", `hey <@${ME}>`), "a", ME);
    expect(map["b"]!.mentioned).toBe(true);
  });

  it("clears unread on read", () => {
    const start = toUnreadMap([{ channelId: "b", unreadCount: 4, lastReadMessageId: null, mentioned: true }]);
    const map = clearUnread(start, "b", "msg_last");
    expect(map["b"]!.unreadCount).toBe(0);
    expect(map["b"]!.lastReadMessageId).toBe("msg_last");
    expect(map["b"]!.mentioned).toBe(false);
  });
});
