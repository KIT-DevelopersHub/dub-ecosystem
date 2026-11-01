import { describe, it, expect, vi } from "vitest";
import { ReadTracker } from "./read-tracker";

interface FakeClock {
  run: () => void;
  pending: () => number;
}

function fakeTimers(): { setTimer: (fn: () => void, ms: number) => number; clearTimer: (h: number) => void } & FakeClock {
  const timers = new Map<number, () => void>();
  let id = 1;
  return {
    setTimer: (fn) => {
      const h = id++;
      timers.set(h, fn);
      return h;
    },
    clearTimer: (h) => {
      timers.delete(h);
    },
    run: () => {
      // Only fire what is due now; timers re-armed by a callback stay pending.
      for (const [h, fn] of [...timers]) {
        timers.delete(h);
        fn();
      }
    },
    pending: () => timers.size,
  };
}

describe("ReadTracker", () => {
  it("debounces and sends the latest observed id when visible", () => {
    const clock = fakeTimers();
    const send = vi.fn();
    const t = new ReadTracker({ send, isVisible: () => true, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    t.observeBottom("msg_a");
    t.observeBottom("msg_b"); // supersedes
    expect(send).not.toHaveBeenCalled();
    clock.run();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("msg_b");
  });

  it("does not send while the tab is hidden, then sends once it becomes visible", () => {
    const clock = fakeTimers();
    const send = vi.fn();
    let visible = false;
    const t = new ReadTracker({ send, isVisible: () => visible, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    t.observeBottom("msg_a");
    clock.run();
    expect(send).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(1); // re-armed, not dropped
    visible = true;
    clock.run();
    expect(send).toHaveBeenCalledWith("msg_a");
  });

  it("ignores ids not newer than what was already sent", () => {
    const clock = fakeTimers();
    const send = vi.fn();
    const t = new ReadTracker({ send, isVisible: () => true, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    t.observeBottom("msg_b");
    clock.run();
    send.mockClear();
    t.observeBottom("msg_a"); // older
    expect(clock.pending()).toBe(0);
    clock.run();
    expect(send).not.toHaveBeenCalled();
  });
});
