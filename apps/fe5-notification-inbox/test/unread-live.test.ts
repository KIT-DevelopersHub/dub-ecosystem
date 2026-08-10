import { describe, expect, it, vi } from "vitest";
import {
  createReconnectingUnreadLive,
  createSseUnreadConnector,
  parseUnreadCount,
  type EventSourceLike,
  type LiveConnection,
  type LiveHandlers,
} from "../src/lib/unread-live";

describe("parseUnreadCount", () => {
  it("parses {count} objects, bare numbers, and integer strings", () => {
    expect(parseUnreadCount('{"count":5}')).toBe(5);
    expect(parseUnreadCount("7")).toBe(7);
    expect(parseUnreadCount("0")).toBe(0);
  });
  it("ignores empty / non-count / malformed frames", () => {
    expect(parseUnreadCount("")).toBeNull();
    expect(parseUnreadCount("   ")).toBeNull();
    expect(parseUnreadCount('{"other":1}')).toBeNull();
    expect(parseUnreadCount("not-json")).toBeNull();
    expect(parseUnreadCount('{"count":"x"}')).toBeNull();
  });
});

describe("createReconnectingUnreadLive", () => {
  it("connects on start and forwards pushed counts", () => {
    let captured: LiveHandlers | null = null;
    const connect = vi.fn((h: LiveHandlers): LiveConnection => {
      captured = h;
      return { close: vi.fn() };
    });
    const onValue = vi.fn();
    const source = createReconnectingUnreadLive({ connect, onValue });

    source.start();
    expect(connect).toHaveBeenCalledOnce();
    captured!.onOpen?.();
    captured!.onCount(4);
    expect(onValue).toHaveBeenCalledWith(4);
  });

  it("start is idempotent (no duplicate connections)", () => {
    const connect = vi.fn((_: LiveHandlers): LiveConnection => ({ close: vi.fn() }));
    const source = createReconnectingUnreadLive({ connect, onValue: vi.fn() });
    source.start();
    source.start();
    expect(connect).toHaveBeenCalledOnce();
  });

  it("reconnects with exponential backoff on transport error", () => {
    const closes: Array<() => void> = [];
    const handlersSeen: LiveHandlers[] = [];
    const connect = vi.fn((h: LiveHandlers): LiveConnection => {
      handlersSeen.push(h);
      const close = vi.fn();
      closes.push(close);
      return { close };
    });
    const delays: number[] = [];
    let fire: (() => void) | null = null;
    const setTimeoutMock = vi.fn((fn: () => void, ms: number) => {
      delays.push(ms);
      fire = fn;
      return 1 as unknown as number;
    });

    const source = createReconnectingUnreadLive({
      connect,
      onValue: vi.fn(),
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      setTimeout: setTimeoutMock,
      clearTimeout: vi.fn(),
    });

    source.start();
    // first connection healthy then errors -> schedule reconnect at base delay
    handlersSeen[0]!.onOpen?.();
    handlersSeen[0]!.onError?.(new Error("drop"));
    expect(closes[0]).toHaveBeenCalledOnce(); // broken conn torn down
    expect(delays).toEqual([1000]);

    // fire reconnect -> second connection; error again WITHOUT onOpen -> backoff doubles
    fire!();
    expect(connect).toHaveBeenCalledTimes(2);
    handlersSeen[1]!.onError?.(new Error("drop again"));
    expect(delays).toEqual([1000, 2000]);
  });

  it("does not reconnect after stop()", () => {
    let captured: LiveHandlers | null = null;
    const close = vi.fn();
    const connect = vi.fn((h: LiveHandlers): LiveConnection => {
      captured = h;
      return { close };
    });
    const setTimeoutMock = vi.fn(() => 1 as unknown as number);
    const source = createReconnectingUnreadLive({
      connect,
      onValue: vi.fn(),
      setTimeout: setTimeoutMock,
      clearTimeout: vi.fn(),
    });
    source.start();
    source.stop();
    expect(close).toHaveBeenCalledOnce();
    // A late error from the closed transport must not schedule a reconnect.
    captured!.onError?.(new Error("late"));
    expect(setTimeoutMock).not.toHaveBeenCalled();
  });
});

describe("createSseUnreadConnector", () => {
  function makeFakeEventSource() {
    const listeners: Record<string, (ev: { data: string }) => void> = {};
    const es: EventSourceLike & { emit: (data: string) => void; emitNamed: (t: string, d: string) => void } = {
      onopen: null,
      onmessage: null,
      onerror: null,
      close: vi.fn(),
      addEventListener(type, listener) {
        listeners[type] = listener;
      },
      emit(data) {
        es.onmessage?.({ data });
      },
      emitNamed(type, data) {
        listeners[type]?.({ data });
      },
    };
    return es;
  }

  it("maps SSE messages (default and named) to onCount and wires open/error", () => {
    const fake = makeFakeEventSource();
    const Ctor = vi.fn(() => fake) as unknown as new () => EventSourceLike;
    const connector = createSseUnreadConnector({
      url: "/api/v1/notifications/inbox/stream",
      EventSourceCtor: Ctor,
    });
    const onCount = vi.fn();
    const onOpen = vi.fn();
    const onError = vi.fn();
    const conn = connector({ onCount, onOpen, onError });

    fake.onopen?.({});
    expect(onOpen).toHaveBeenCalledOnce();

    fake.emit('{"count":3}');
    expect(onCount).toHaveBeenCalledWith(3);

    fake.emitNamed("unread-count", "9");
    expect(onCount).toHaveBeenCalledWith(9);

    fake.onerror?.({});
    expect(onError).toHaveBeenCalledOnce();

    conn.close();
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("reports an error when no EventSource is available", () => {
    const connector = createSseUnreadConnector({
      url: "/stream",
      EventSourceCtor: undefined,
    });
    const onError = vi.fn();
    // Ensure the global fallback is absent for this call.
    const prev = (globalThis as { EventSource?: unknown }).EventSource;
    delete (globalThis as { EventSource?: unknown }).EventSource;
    try {
      connector({ onCount: vi.fn(), onError });
      expect(onError).toHaveBeenCalledOnce();
    } finally {
      if (prev !== undefined) (globalThis as { EventSource?: unknown }).EventSource = prev;
    }
  });
});
