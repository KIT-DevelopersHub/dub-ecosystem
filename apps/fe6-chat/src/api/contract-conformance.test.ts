// Contract-adherence tests (design §7 "契約適合"): mock gateway responses must
// match the @dub/types chat shapes, and RT frames must match the frozen
// ChatRealtimeEvent wire contract. zod validates the runtime payloads.
import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { chat, identity } from "@dub/types";
import type { Channel, Message } from "./contract";
import { MockChatClient } from "./mock-client";
import { demoSeed } from "../dev/seed";
import { chatFeature } from "../feature";

// Compile-time conformance to the frozen @dub/types chat STUB shells. FE6 implements
// against the *expected* (richer) contract while chat-service is △ 9-C, but the fields
// the stub already froze (chat.ChatChannel / chat.ChatMessage) must stay a subset of
// FE6's shapes — so FE6's Channel/Message remain assignable to them. When 9-C activates
// and replaces the stub with the real shape, any drift breaks this assignment at tsc.
const _channelConformsToFrozenStub: (c: Channel) => chat.ChatChannel = (c) => c;
const _messageConformsToFrozenStub: (m: Message) => chat.ChatMessage = (m) => m;
void _channelConformsToFrozenStub;
void _messageConformsToFrozenStub;

// A representative slice of @dub/ui's IconName union. NavEntry.icon is now typed as
// IconName, so an out-of-set icon (e.g. "chat") already fails typecheck; this runtime
// list is a defense-in-depth check that the icons FE6 ships stay in the canonical set.
const ICON_NAMES = [
  "home",
  "calendar",
  "check-square",
  "bell",
  "message-square",
  "shield",
  "settings",
  "users",
  "file",
  "alert-triangle",
  "log-out",
] as const;

const reactionSchema = z.object({ emoji: z.string(), userIds: z.array(z.string()) });
const messageSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  authorId: z.string(),
  body: z.string(),
  threadRootId: z.string().nullable(),
  replyCount: z.number(),
  reactions: z.array(reactionSchema),
  attachments: z.array(z.object({ fileId: z.string(), name: z.string(), mime: z.string(), size: z.number() })),
  editedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
});
const channelSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  type: z.enum(["topic", "event", "dm"]),
  name: z.string(),
  topic: z.string().nullable(),
  eventId: z.string().nullable(),
  archived: z.boolean(),
  memberCount: z.number(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const unreadSchema = z.object({
  channelId: z.string(),
  unreadCount: z.number(),
  lastReadMessageId: z.string().nullable(),
  mentioned: z.boolean(),
});
const wsTicketSchema = z.object({ ticket: z.string(), doUrl: z.string(), expiresAt: z.string() });
const userSummarySchema = z.object({ id: z.string(), displayName: z.string(), avatarUrl: z.string().nullable() });
const rtEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message.created"), channelId: z.string(), messageId: z.string(), authorId: z.string(), body: z.string(), at: z.string() }),
  z.object({ kind: z.literal("message.deleted"), channelId: z.string(), messageId: z.string(), at: z.string() }),
  z.object({ kind: z.literal("member.added"), channelId: z.string(), userId: z.string(), at: z.string() }),
  z.object({ kind: z.literal("member.removed"), channelId: z.string(), userId: z.string(), at: z.string() }),
]);

describe("contract conformance", () => {
  const api = new MockChatClient(demoSeed());

  it("channels match the Channel schema", async () => {
    for (const c of await api.listChannels()) expect(channelSchema.safeParse(c).success).toBe(true);
  });

  it("messages match the Message schema", async () => {
    const page = await api.listMessages({ channelId: "chn_general00000000000000000", limit: 50 });
    for (const m of page.items) expect(messageSchema.safeParse(m).success).toBe(true);
  });

  it("channels/messages carry every field frozen in the @dub/types chat STUB", async () => {
    // Only the fields chat.ChatChannel / chat.ChatMessage already froze (9-C pending).
    const stubChannel = z.object({ id: z.string(), name: z.string(), createdAt: z.string() });
    const stubMessage = z.object({
      id: z.string(),
      channelId: z.string(),
      authorId: z.string(),
      body: z.string(),
      createdAt: z.string(),
    });
    for (const c of await api.listChannels()) expect(stubChannel.safeParse(c).success).toBe(true);
    const page = await api.listMessages({ channelId: "chn_general00000000000000000", limit: 50 });
    for (const m of page.items) expect(stubMessage.safeParse(m).success).toBe(true);
  });

  it("unread summaries match the UnreadSummary schema", async () => {
    for (const u of await api.listUnread()) expect(unreadSchema.safeParse(u).success).toBe(true);
  });

  it("ws-ticket matches WsTicketResponse (doUrl is DO-direct)", async () => {
    const ticket = await api.getWsTicket("chn_general00000000000000000");
    expect(wsTicketSchema.safeParse(ticket).success).toBe(true);
    // typed against the frozen contract
    const typed: chat.WsTicketResponse = ticket;
    expect(typed.doUrl).toContain("wss://");
  });

  it("resolveUsers match the identity UserSummary schema", async () => {
    const users = await api.resolveUsers(["usr_me0000000000000000000000"]);
    for (const u of users) {
      expect(userSummarySchema.safeParse(u).success).toBe(true);
      const typed: identity.UserSummary = u; // compile-time conformance
      expect(typed.id).toBeTypeOf("string");
    }
  });

  it("RT frames validate against the frozen ChatRealtimeEvent union", () => {
    const events: chat.ChatRealtimeEvent[] = [
      { kind: "message.created", channelId: "c", messageId: "m", authorId: "u", body: "b", at: "2026-08-09T00:00:00Z" },
      { kind: "message.deleted", channelId: "c", messageId: "m", at: "2026-08-09T00:00:00Z" },
      { kind: "member.added", channelId: "c", userId: "u", at: "2026-08-09T00:00:00Z" },
      { kind: "member.removed", channelId: "c", userId: "u", at: "2026-08-09T00:00:00Z" },
    ];
    for (const e of events) expect(rtEventSchema.safeParse(e).success).toBe(true);
  });
});

describe("FeatureModule shape conformance (FE2 shell contract)", () => {
  it("nav is a non-empty array of NavEntry-shaped objects", () => {
    expect(Array.isArray(chatFeature.nav)).toBe(true);
    expect(chatFeature.nav.length).toBeGreaterThan(0);
    for (const n of chatFeature.nav) {
      expect(n.label).toBeTypeOf("string");
      expect(n.path).toBeTypeOf("string");
      expect(n.order).toBeTypeOf("number");
    }
  });

  it("every nav icon is a member of FE2's canonical IconName union", () => {
    for (const n of chatFeature.nav) {
      expect(ICON_NAMES).toContain(n.icon);
    }
  });

  it("routes is a non-empty array; each route has a lazy factory and an auth mode", () => {
    expect(Array.isArray(chatFeature.routes)).toBe(true);
    expect(chatFeature.routes.length).toBeGreaterThan(0);
    for (const r of chatFeature.routes) {
      expect(r.path.startsWith("/")).toBe(true);
      expect(r.lazy).toBeTypeOf("function");
      expect(["required", "public"]).toContain(r.auth);
    }
  });
});
