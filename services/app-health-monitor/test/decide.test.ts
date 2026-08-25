import { describe, it, expect } from "vitest";
import { decide } from "../src/monitor";
import type { TargetResult, TargetState } from "../src/types";

const T0 = "2026-08-19T00:00:00.000Z";
const T1 = "2026-08-19T01:00:00.000Z";
const T2 = "2026-08-19T02:00:00.000Z";

function down(id = "fe:mail"): TargetResult {
  return { id, kind: "frontend", label: "画面: メール", status: "down", detail: "HTTP 404 chunk missing" };
}
function ok(id = "fe:mail"): TargetResult {
  return { id, kind: "frontend", label: "画面: メール", status: "ok", detail: "route+chunks ok" };
}

describe("decide() flapping state machine", () => {
  it("first failure does NOT fire (below threshold=2) but records downSince + fails=1", () => {
    const t = decide(null, down(), T0);
    expect(t.fire).toBeNull();
    expect(t.next.consecutiveFails).toBe(1);
    expect(t.next.downSince).toBe(T0);
    expect(t.next.notified).toBe(false);
  });

  it("second consecutive failure fires 'down' once and marks notified", () => {
    const prev: TargetState = { targetId: "fe:mail", status: "down", consecutiveFails: 1, downSince: T0, notified: false, lastError: "x", lastCheckedAt: T0 };
    const t = decide(prev, down(), T1);
    expect(t.fire).toBe("down");
    expect(t.next.consecutiveFails).toBe(2);
    expect(t.next.downSince).toBe(T0); // streak start preserved
    expect(t.next.notified).toBe(true);
  });

  it("further failures while already notified do NOT re-fire", () => {
    const prev: TargetState = { targetId: "fe:mail", status: "down", consecutiveFails: 2, downSince: T0, notified: true, lastError: "x", lastCheckedAt: T1 };
    const t = decide(prev, down(), T2);
    expect(t.fire).toBeNull();
    expect(t.next.consecutiveFails).toBe(3);
    expect(t.next.notified).toBe(true);
  });

  it("recovery fires ONLY when we had actually alerted", () => {
    const notifiedDown: TargetState = { targetId: "fe:mail", status: "down", consecutiveFails: 2, downSince: T0, notified: true, lastError: "x", lastCheckedAt: T1 };
    const t = decide(notifiedDown, ok(), T2);
    expect(t.fire).toBe("recovery");
    expect(t.next.status).toBe("ok");
    expect(t.next.consecutiveFails).toBe(0);
    expect(t.next.notified).toBe(false);
    expect(t.next.downSince).toBeNull();
  });

  it("recovery does NOT fire when a single blip (fails=1, never notified) clears", () => {
    const blip: TargetState = { targetId: "fe:mail", status: "down", consecutiveFails: 1, downSince: T0, notified: false, lastError: "x", lastCheckedAt: T0 };
    const t = decide(blip, ok(), T1);
    expect(t.fire).toBeNull();
    expect(t.next.status).toBe("ok");
  });

  it("steady ok stays ok with no fire", () => {
    const good: TargetState = { targetId: "fe:mail", status: "ok", consecutiveFails: 0, downSince: null, notified: false, lastError: null, lastCheckedAt: T0 };
    const t = decide(good, ok(), T1);
    expect(t.fire).toBeNull();
    expect(t.next.status).toBe("ok");
  });
});
