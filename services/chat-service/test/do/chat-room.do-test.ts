// ChatRoom Durable Object — real-runtime tests (workerd via miniflare).
// Covers: ws-ticket verification at connect, Origin allow-listing, WS message
// delivery / per-channel fanout isolation, and the DoRealtimePublisher wiring.
import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { chat } from "@dub/types";
import { signWsTicket, ticketExpiryMs } from "../../src/wsticket";
import { DoRealtimePublisher } from "../../src/realtime";

const SECRET = "test-secret"; // matches WS_TICKET_SECRET binding in vitest.workers.config.ts
const ALLOWED_ORIGIN = "https://app.developershub.jp";
// CHAT_ROOM is optional on Env (Noop fallback in local/preview) but always bound here.
const CHAT_ROOM = env.CHAT_ROOM!;

async function ticketFor(channelId: string, userId: string, opts: { exp?: number } = {}): Promise<string> {
  return signWsTicket(SECRET, {
    channelId,
    userId,
    expEpochMs: opts.exp ?? ticketExpiryMs(),
  });
}

/** Open a WS through the worker's /ws routing (index.ts -> ChatRoom DO). */
async function connect(
  channelId: string,
  ticket: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return SELF.fetch(`https://chat-rt.test/ws/${encodeURIComponent(channelId)}?ticket=${encodeURIComponent(ticket)}`, {
    headers: { Upgrade: "websocket", ...headers },
  });
}

/** Resolve with the next message, or reject after `ms` (used to assert delivery). */
function nextMessage(ws: WebSocket, ms = 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for message")), ms);
    ws.addEventListener("message", (e: MessageEvent) => {
      clearTimeout(timer);
      resolve(e.data as string);
    }, { once: true });
  });
}

/** Assert NO message arrives within `ms`. */
function expectSilence(ws: WebSocket, ms = 250): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener("message", () => reject(new Error("unexpected message")), { once: true });
    setTimeout(resolve, ms);
  });
}

const sampleEvent = (channelId: string): chat.ChatRealtimeEvent => ({
  kind: "message.created",
  channelId,
  messageId: "msg_1",
  authorId: "user_a",
  body: "hello",
  at: "2026-08-09T00:00:00.000Z",
});

describe("ChatRoom DO — ws-ticket verification at connect", () => {
  it("accepts a valid ticket (101 upgrade)", async () => {
    const ch = "chan_ok";
    const res = await connect(ch, await ticketFor(ch, "user_a"));
    expect(res.status).toBe(101);
    expect(res.webSocket).toBeTruthy();
    res.webSocket!.accept();
    res.webSocket!.close();
  });

  it("rejects a missing ticket (401, no upgrade)", async () => {
    const res = await SELF.fetch("https://chat-rt.test/ws/chan_x", { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(401);
    expect(res.webSocket).toBeFalsy();
  });

  it("rejects a ticket signed with the wrong secret (401)", async () => {
    const ch = "chan_wrongsecret";
    const bad = await signWsTicket("not-the-secret", { channelId: ch, userId: "user_a", expEpochMs: ticketExpiryMs() });
    const res = await connect(ch, bad);
    expect(res.status).toBe(401);
  });

  it("rejects an expired ticket (401)", async () => {
    const ch = "chan_expired";
    const res = await connect(ch, await ticketFor(ch, "user_a", { exp: Date.now() - 1000 }));
    expect(res.status).toBe(401);
  });

  it("rejects a ticket whose channel differs from the URL (403)", async () => {
    const other = await ticketFor("chan_other", "user_a");
    const res = await connect("chan_target", other);
    expect(res.status).toBe(403);
  });

  it("requires the websocket upgrade header (426)", async () => {
    const ch = "chan_noupgrade";
    const res = await SELF.fetch(`https://chat-rt.test/ws/${ch}?ticket=${await ticketFor(ch, "user_a")}`);
    // index.ts only routes to the DO on an Upgrade request; without it the request
    // falls through to the HTTP app and is not a 101.
    expect(res.status).not.toBe(101);
  });
});

describe("ChatRoom DO — Origin allow-listing", () => {
  it("accepts the allowed SPA origin", async () => {
    const ch = "chan_origin_ok";
    const res = await connect(ch, await ticketFor(ch, "user_a"), { Origin: ALLOWED_ORIGIN });
    expect(res.status).toBe(101);
    res.webSocket!.accept();
    res.webSocket!.close();
  });

  it("rejects a disallowed browser origin (403)", async () => {
    const ch = "chan_origin_bad";
    const res = await connect(ch, await ticketFor(ch, "user_a"), { Origin: "https://evil.example.com" });
    expect(res.status).toBe(403);
  });

  it("allows a native client with no Origin header", async () => {
    const ch = "chan_no_origin";
    const res = await connect(ch, await ticketFor(ch, "user_a"));
    expect(res.status).toBe(101);
    res.webSocket!.accept();
    res.webSocket!.close();
  });
});

describe("ChatRoom DO — message delivery & fanout", () => {
  it("fans a published event out to every connected socket in the channel", async () => {
    const ch = "chan_fanout";
    const a = await connect(ch, await ticketFor(ch, "user_a"));
    const b = await connect(ch, await ticketFor(ch, "user_b"));
    a.webSocket!.accept();
    b.webSocket!.accept();
    const gotA = nextMessage(a.webSocket!);
    const gotB = nextMessage(b.webSocket!);

    const delivered = await CHAT_ROOM.getByName(ch).publish(sampleEvent(ch));
    expect(delivered).toBe(2);

    const [ma, mb] = await Promise.all([gotA, gotB]);
    expect(JSON.parse(ma)).toMatchObject({ kind: "message.created", channelId: ch, messageId: "msg_1" });
    expect(JSON.parse(mb)).toMatchObject({ kind: "message.created", channelId: ch });
    a.webSocket!.close();
    b.webSocket!.close();
  });

  it("does NOT deliver a channel's event to a different channel's sockets", async () => {
    const ch1 = "chan_isolated_1";
    const ch2 = "chan_isolated_2";
    const s1 = await connect(ch1, await ticketFor(ch1, "user_a"));
    const s2 = await connect(ch2, await ticketFor(ch2, "user_b"));
    s1.webSocket!.accept();
    s2.webSocket!.accept();

    const heard = nextMessage(s1.webSocket!);
    const silence = expectSilence(s2.webSocket!);

    await CHAT_ROOM.getByName(ch1).publish(sampleEvent(ch1));

    expect(JSON.parse(await heard)).toMatchObject({ channelId: ch1 });
    await expect(silence).resolves.toBeUndefined();
    s1.webSocket!.close();
    s2.webSocket!.close();
  });

  it("publish to an empty channel delivers to nobody", async () => {
    const delivered = await CHAT_ROOM.getByName("chan_empty").publish(sampleEvent("chan_empty"));
    expect(delivered).toBe(0);
  });

  it("reports presence (connected socket count)", async () => {
    const ch = "chan_presence";
    const stub = CHAT_ROOM.getByName(ch);
    expect(await stub.presence()).toBe(0);
    const s = await connect(ch, await ticketFor(ch, "user_a"));
    s.webSocket!.accept();
    expect(await stub.presence()).toBe(1);
    s.webSocket!.close();
  });
});

describe("DoRealtimePublisher — real RT wiring (master -> DO)", () => {
  it("routes publishToChannel to the channel DO and reaches connected sockets", async () => {
    const ch = "chan_publisher";
    const publisher = new DoRealtimePublisher(CHAT_ROOM);
    const s = await connect(ch, await ticketFor(ch, "user_a"));
    s.webSocket!.accept();
    const got = nextMessage(s.webSocket!);

    await publisher.publishToChannel(ch, { kind: "member.added", channelId: ch, userId: "user_z", at: "2026-08-09T00:00:00.000Z" });

    expect(JSON.parse(await got)).toEqual({ kind: "member.added", channelId: ch, userId: "user_z", at: "2026-08-09T00:00:00.000Z" });
    s.webSocket!.close();
  });
});
