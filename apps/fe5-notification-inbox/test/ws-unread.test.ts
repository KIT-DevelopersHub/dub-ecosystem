import { describe, expect, it, vi } from "vitest";
import { createWsUnreadConnector } from "../src/lib/ws-unread";
import type { LiveHandlers } from "../src/lib/unread-live";

// Minimal fake WebSocket driving the connector's handlers.
class FakeWs {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {}
  close(): void {
    this.closed = true;
  }
}

const handlers = (over: Partial<LiveHandlers> = {}): LiveHandlers => ({
  onCount: vi.fn(),
  onOpen: vi.fn(),
  onError: vi.fn(),
  ...over,
});

// Let the connector's async ticket-fetch + open run.
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("createWsUnreadConnector", () => {
  it("fetches a fresh ticket, opens ws with ticket query, and refetches count on open + on message", async () => {
    let created: FakeWs | null = null;
    const getTicket = vi.fn(async () => ({ ticket: "tkt-1", doUrl: "wss://n/ws/u1" }));
    const fetchCount = vi.fn(async () => 3);
    const connector = createWsUnreadConnector({
      getTicket,
      fetchCount,
      wsFactory: (url) => {
        created = new FakeWs(url) as unknown as WebSocket as unknown as FakeWs;
        return created as unknown as WebSocket;
      },
    });
    const h = handlers();
    connector(h);
    await flush();

    expect(getTicket).toHaveBeenCalledOnce();
    expect(created).not.toBeNull();
    expect(created!.url).toBe("wss://n/ws/u1?ticket=tkt-1");

    // on open -> reconcile immediately
    created!.onopen!();
    await flush();
    expect(h.onOpen).toHaveBeenCalledOnce();
    expect(fetchCount).toHaveBeenCalledTimes(1);
    expect(h.onCount).toHaveBeenLastCalledWith(3);

    // server "inbox-changed" frame -> refetch authoritative count
    created!.onmessage!({ data: '{"kind":"inbox-changed"}' });
    await flush();
    expect(fetchCount).toHaveBeenCalledTimes(2);
    expect(h.onCount).toHaveBeenLastCalledWith(3);
  });

  it("ignores pong liveness frames (no refetch)", async () => {
    let created: FakeWs | null = null;
    const fetchCount = vi.fn(async () => 1);
    const connector = createWsUnreadConnector({
      getTicket: async () => ({ ticket: "t", doUrl: "wss://n/ws/u" }),
      fetchCount,
      wsFactory: (url) => {
        created = new FakeWs(url) as unknown as FakeWs;
        return created as unknown as WebSocket;
      },
    });
    connector(handlers());
    await flush();
    created!.onmessage!({ data: "pong" });
    await flush();
    expect(fetchCount).not.toHaveBeenCalled();
  });

  it("reports onError when the socket closes so the reconnecting source backs off", async () => {
    let created: FakeWs | null = null;
    const onError = vi.fn();
    const connector = createWsUnreadConnector({
      getTicket: async () => ({ ticket: "t", doUrl: "wss://n/ws/u" }),
      fetchCount: async () => 0,
      wsFactory: (url) => {
        created = new FakeWs(url) as unknown as FakeWs;
        return created as unknown as WebSocket;
      },
    });
    connector(handlers({ onError }));
    await flush();
    created!.onclose!();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("surfaces a ticket-fetch failure as onError (no ws opened)", async () => {
    const onError = vi.fn();
    const wsFactory = vi.fn();
    const connector = createWsUnreadConnector({
      getTicket: async () => {
        throw new Error("ticket 401");
      },
      fetchCount: async () => 0,
      wsFactory: wsFactory as unknown as (u: string) => WebSocket,
    });
    connector(handlers({ onError }));
    await flush();
    expect(onError).toHaveBeenCalledOnce();
    expect(wsFactory).not.toHaveBeenCalled();
  });

  it("does not open the socket if closed before the ticket resolves", async () => {
    const wsFactory = vi.fn();
    let resolveTicket!: (v: { ticket: string; doUrl: string }) => void;
    const connector = createWsUnreadConnector({
      getTicket: () => new Promise((r) => (resolveTicket = r)),
      fetchCount: async () => 0,
      wsFactory: wsFactory as unknown as (u: string) => WebSocket,
    });
    const conn = connector(handlers());
    conn.close();
    resolveTicket({ ticket: "t", doUrl: "wss://n/ws/u" });
    await flush();
    expect(wsFactory).not.toHaveBeenCalled();
  });
});
