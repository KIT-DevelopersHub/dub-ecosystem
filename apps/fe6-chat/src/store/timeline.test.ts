import { describe, it, expect } from "vitest";
import type { ChatRealtimeEvent, Message } from "../api/contract";
import {
  ackPending,
  applyReactions,
  reactionsFromWire,
  addPending,
  applyRealtimeEvent,
  failPending,
  markDeleted,
  mergeMessages,
  toggleReactionLocal,
  upsertMessage,
} from "./timeline";
import { emptyChannelView, type PendingMessage } from "../types";

const CH = "chn_test";
const ME = "usr_me";
const OTHER = "usr_other";

function msg(id: string, over: Partial<Message> = {}): Message {
  return {
    id,
    channelId: CH,
    authorId: OTHER,
    body: "hi",
    threadRootId: null,
    replyCount: 0,
    reactions: [],
    attachments: [],
    editedAt: null,
    deletedAt: null,
    version: 1,
    createdAt: "2026-08-09T01:00:00Z",
    ...over,
  };
}

describe("upsertMessage", () => {
  it("keeps ULID ascending order regardless of insertion order", () => {
    let m: Message[] = [];
    m = upsertMessage(m, msg("msg_c"));
    m = upsertMessage(m, msg("msg_a"));
    m = upsertMessage(m, msg("msg_b"));
    expect(m.map((x) => x.id)).toEqual(["msg_a", "msg_b", "msg_c"]);
  });

  it("replaces an existing id instead of duplicating", () => {
    let m = [msg("msg_a", { body: "old" })];
    m = upsertMessage(m, msg("msg_a", { body: "new", version: 2 }));
    expect(m).toHaveLength(1);
    expect(m[0]!.body).toBe("new");
  });
});

describe("mergeMessages", () => {
  it("merges a page without duplicates or gaps", () => {
    const existing = [msg("msg_b"), msg("msg_d")];
    const page = [msg("msg_a"), msg("msg_c"), msg("msg_b")]; // overlap on b
    const merged = mergeMessages(existing, page);
    expect(merged.map((x) => x.id)).toEqual(["msg_a", "msg_b", "msg_c", "msg_d"]);
  });
});

describe("markDeleted", () => {
  it("tombstones body + attachments in place", () => {
    const m = [msg("msg_a", { body: "secret", attachments: [{ fileId: "f", name: "n", mime: "x", size: 1 }] })];
    const out = markDeleted(m, "msg_a", "2026-08-09T02:00:00Z");
    expect(out[0]!.deletedAt).toBe("2026-08-09T02:00:00Z");
    expect(out[0]!.body).toBe("");
    expect(out[0]!.attachments).toEqual([]);
  });
});

describe("applyRealtimeEvent", () => {
  it("ignores events for other channels", () => {
    const state = emptyChannelView(CH);
    const ev: ChatRealtimeEvent = { kind: "message.created", channelId: "chn_other", messageId: "msg_x", authorId: OTHER, body: "y", at: "2026-08-09T01:00:00Z" };
    expect(applyRealtimeEvent(state, ev, ME)).toBe(state);
  });

  it("inserts a created message at its ULID position", () => {
    let state = { ...emptyChannelView(CH), messages: [msg("msg_a"), msg("msg_c")] };
    const ev: ChatRealtimeEvent = { kind: "message.created", channelId: CH, messageId: "msg_b", authorId: OTHER, body: "mid", at: "2026-08-09T01:00:00Z" };
    state = applyRealtimeEvent(state, ev, ME);
    expect(state.messages.map((m) => m.id)).toEqual(["msg_a", "msg_b", "msg_c"]);
  });

  it("dedupes my own pending echo (same author + body)", () => {
    const pending: PendingMessage = {
      clientTempId: "tmp_1",
      authorId: ME,
      state: "sending",
      createdAt: "2026-08-09T01:00:00Z",
      request: { channelId: CH, body: "hello world", clientTempId: "tmp_1" },
    };
    let state = addPending(emptyChannelView(CH), pending);
    const ev: ChatRealtimeEvent = { kind: "message.created", channelId: CH, messageId: "msg_real", authorId: ME, body: "hello world", at: "2026-08-09T01:00:00Z" };
    state = applyRealtimeEvent(state, ev, ME);
    expect(state.pending).toHaveLength(0);
    expect(state.messages.map((m) => m.id)).toEqual(["msg_real"]);
  });

  it("tombstones on message.deleted", () => {
    let state = { ...emptyChannelView(CH), messages: [msg("msg_a", { body: "x" })] };
    state = applyRealtimeEvent(state, { kind: "message.deleted", channelId: CH, messageId: "msg_a", at: "2026-08-09T03:00:00Z" }, ME);
    expect(state.messages[0]!.deletedAt).toBe("2026-08-09T03:00:00Z");
  });

  it("leaves timeline unchanged for member events", () => {
    const state = { ...emptyChannelView(CH), messages: [msg("msg_a")] };
    const out = applyRealtimeEvent(state, { kind: "member.added", channelId: CH, userId: OTHER, at: "2026-08-09T01:00:00Z" }, ME);
    expect(out).toBe(state);
  });
});

describe("pending lifecycle", () => {
  it("ack drops pending and inserts the real message", () => {
    const pending: PendingMessage = {
      clientTempId: "tmp_1",
      authorId: ME,
      state: "sending",
      createdAt: "2026-08-09T01:00:00Z",
      request: { channelId: CH, body: "hi", clientTempId: "tmp_1" },
    };
    let state = addPending(emptyChannelView(CH), pending);
    state = ackPending(state, "tmp_1", msg("msg_real", { authorId: ME }));
    expect(state.pending).toHaveLength(0);
    expect(state.messages[0]!.id).toBe("msg_real");
  });

  it("fail marks pending failed without removing", () => {
    const pending: PendingMessage = {
      clientTempId: "tmp_1",
      authorId: ME,
      state: "sending",
      createdAt: "2026-08-09T01:00:00Z",
      request: { channelId: CH, body: "hi", clientTempId: "tmp_1" },
    };
    let state = addPending(emptyChannelView(CH), pending);
    state = failPending(state, "tmp_1");
    expect(state.pending[0]!.state).toBe("failed");
  });
});

describe("toggleReactionLocal", () => {
  it("adds, then removes a reaction for the same user", () => {
    let m = [msg("msg_a")];
    m = toggleReactionLocal(m, "msg_a", "👍", ME);
    expect(m[0]!.reactions).toEqual([{ emoji: "👍", userIds: [ME] }]);
    m = toggleReactionLocal(m, "msg_a", "👍", ME);
    expect(m[0]!.reactions).toEqual([]);
  });

  it("appends a second user to an existing reaction", () => {
    let m = [msg("msg_a", { reactions: [{ emoji: "👍", userIds: [OTHER] }] })];
    m = toggleReactionLocal(m, "msg_a", "👍", ME);
    expect(m[0]!.reactions[0]!.userIds).toEqual([OTHER, ME]);
  });
});

describe("normalizeMessage (wire -> client Message coercion)", () => {
  it("upsertMessage coerces a chat-service wire message so render never sees undefined", () => {
    // The server wire shape: attachmentFileIds + reactions-as-Record, no replyCount.
    const wire = {
      id: "msg_01",
      channelId: CH,
      authorId: OTHER,
      body: "hi",
      attachmentFileIds: ["file_a"],
      reactions: { "🎉": ["usr_1", "usr_2"] },
      version: 1,
      editedAt: null,
      deletedAt: null,
      createdAt: "2026-08-18T00:00:00.000Z",
    } as unknown as Message;
    const m = upsertMessage([], wire)[0]!;
    expect(Array.isArray(m.attachments)).toBe(true);
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0]!.fileId).toBe("file_a");
    expect(Array.isArray(m.reactions)).toBe(true);
    expect(m.reactions).toEqual([{ emoji: "🎉", userIds: ["usr_1", "usr_2"] }]);
    expect(m.replyCount).toBe(0);
    expect(m.threadRootId).toBeNull();
  });

  it("is idempotent for an already client-shaped message", () => {
    const m = msg("msg_02", { reactions: [{ emoji: "👍", userIds: [ME] }], attachments: [], replyCount: 3 });
    const out = upsertMessage([], m)[0]!;
    expect(out.reactions).toEqual([{ emoji: "👍", userIds: [ME] }]);
    expect(out.attachments).toEqual([]);
    expect(out.replyCount).toBe(3);
  });
});

describe("applyReactions (reaction-toggle reconcile)", () => {
  it("replaces the target message's reactions from the server's authoritative set", () => {
    const base = upsertMessage([], msg("msg_r1", { reactions: [] }));
    const out = applyReactions(base, "msg_r1", [{ emoji: "🎉", userIds: [ME, OTHER] }]);
    expect(out[0]!.reactions).toEqual([{ emoji: "🎉", userIds: [ME, OTHER] }]);
    // does not inject a phantom entry (bug: upsertMessage on { messageId, reactions })
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("msg_r1");
  });

  it("is a no-op when the message is not loaded", () => {
    const base = upsertMessage([], msg("msg_r2"));
    const out = applyReactions(base, "msg_absent", [{ emoji: "👍", userIds: [ME] }]);
    expect(out).toBe(base);
  });
});

describe("reactionsFromWire", () => {
  it("converts a Record<emoji, userIds> to Reaction[]", () => {
    expect(reactionsFromWire({ "🎉": ["u1"], "👍": ["u1", "u2"] })).toEqual([
      { emoji: "🎉", userIds: ["u1"] },
      { emoji: "👍", userIds: ["u1", "u2"] },
    ]);
  });
  it("passes an array through and tolerates undefined", () => {
    expect(reactionsFromWire([{ emoji: "🔥", userIds: ["u1"] }])).toEqual([{ emoji: "🔥", userIds: ["u1"] }]);
    expect(reactionsFromWire(undefined)).toEqual([]);
  });
});

describe("applyRealtimeEvent — thread replies stay out of the main timeline", () => {
  it("a reply event bumps the root's replyCount and does NOT insert into main", () => {
    const root = msg("msg_root", { replyCount: 0 });
    const base = upsertMessage([], root);
    const view = { ...emptyChannelView(CH), messages: base };
    const ev: ChatRealtimeEvent = {
      kind: "message.created",
      channelId: CH as any,
      messageId: "msg_reply" as any,
      authorId: OTHER as any,
      body: "a reply",
      at: "2026-08-18T00:00:00.000Z" as any,
      threadRootId: "msg_root" as any,
    };
    const next = applyRealtimeEvent(view, ev, ME as any);
    expect(next.messages).toHaveLength(1); // reply not inserted into main
    expect(next.messages[0]!.id).toBe("msg_root");
    expect(next.messages[0]!.replyCount).toBe(1); // summary bumped live
  });

  it("a top-level event still inserts into main", () => {
    const view = emptyChannelView(CH);
    const ev: ChatRealtimeEvent = {
      kind: "message.created",
      channelId: CH as any,
      messageId: "msg_top" as any,
      authorId: OTHER as any,
      body: "hi",
      at: "2026-08-18T00:00:00.000Z" as any,
    };
    const next = applyRealtimeEvent(view, ev, ME as any);
    expect(next.messages.map((m) => m.id)).toContain("msg_top");
  });
});
