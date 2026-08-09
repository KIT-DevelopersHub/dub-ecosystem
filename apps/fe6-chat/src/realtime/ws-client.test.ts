import { describe, it, expect, vi } from "vitest";
import { WsChatClient } from "./ws-client";
import type { WsTicketResponse } from "../api/contract";
import type { RealtimeStatus } from "./client";

class FakeWs {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {}
  close() {
    this.closed = true;
  }
}

const ticket = (n: number): WsTicketResponse => ({
  ticket: `t${n}`,
  doUrl: "wss://chat-rt.developershub.jp/ws/chn_a",
  expiresAt: "2026-08-09T01:00:00Z",
});

function harness() {
  const sockets: FakeWs[] = [];
  const timers: Array<() => void> = [];
  const getTicket = vi.fn(async () => ticket(sockets.length + 1));
  const client = new WsChatClient({
    getTicket,
    wsFactory: (url) => {
      const ws = new FakeWs(url);
      sockets.push(ws);
      return ws as unknown as WebSocket;
    },
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => undefined,
  });
  const statuses: RealtimeStatus[] = [];
  client.onStatusChange((s) => statuses.push(s));
  return { client, sockets, timers, getTicket, statuses };
}

describe("WsChatClient", () => {
  it("passes the ticket as a query param on the DO-direct URL", () => {
    const h = harness();
    h.client.connect("chn_a", ticket(1));
    expect(h.sockets[0]!.url).toContain("wss://chat-rt.developershub.jp/ws/chn_a");
    expect(h.sockets[0]!.url).toContain("ticket=t1");
  });

  it("reports open then delivers parsed events", () => {
    const h = harness();
    const received: unknown[] = [];
    h.client.onEvent((e) => received.push(e));
    h.client.connect("chn_a", ticket(1));
    h.sockets[0]!.onopen?.();
    expect(h.statuses).toContain("open");
    h.sockets[0]!.onmessage?.({ data: JSON.stringify({ kind: "message.created", channelId: "chn_a", messageId: "m", authorId: "u", body: "hi", at: "2026-08-09T00:00:00Z" }) });
    expect(received).toHaveLength(1);
  });

  it("ignores malformed frames", () => {
    const h = harness();
    const received: unknown[] = [];
    h.client.onEvent((e) => received.push(e));
    h.client.connect("chn_a", ticket(1));
    h.sockets[0]!.onmessage?.({ data: "not json" });
    h.sockets[0]!.onmessage?.({ data: JSON.stringify({ kind: "unknown" }) });
    expect(received).toHaveLength(0);
  });

  it("reconnects with a fresh ticket after an unexpected close", async () => {
    const h = harness();
    h.client.connect("chn_a", ticket(1));
    h.sockets[0]!.onopen?.();
    h.sockets[0]!.onclose?.(); // unexpected drop -> schedule reconnect
    expect(h.statuses).toContain("reconnecting");
    expect(h.timers).toHaveLength(1);
    h.timers[0]!(); // fire the backoff timer (async ticket fetch inside)
    await new Promise((r) => setTimeout(r, 0)); // flush the getTicket().then()
    // a fresh ticket was fetched and a new socket opened
    expect(h.getTicket).toHaveBeenCalledTimes(1);
    expect(h.sockets).toHaveLength(2);
  });

  it("stops reconnecting after an explicit disconnect", () => {
    const h = harness();
    h.client.connect("chn_a", ticket(1));
    h.sockets[0]!.onopen?.();
    h.client.disconnect();
    h.sockets[0]!.onclose?.(); // close fired by our own disconnect
    expect(h.timers).toHaveLength(0);
    expect(h.statuses[h.statuses.length - 1]).toBe("closed");
  });
});
