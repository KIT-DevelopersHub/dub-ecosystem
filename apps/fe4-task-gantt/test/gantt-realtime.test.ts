import { describe, it, expect, vi } from "vitest";
import type { gantt } from "@dub/types";
import { applyGanttRealtimeEvent, type GanttRealtimeActions } from "../src/api/useGanttRealtime";

function actions(): GanttRealtimeActions & { moves: unknown[]; invalidations: number } {
  const moves: unknown[] = [];
  let invalidations = 0;
  return {
    moves,
    get invalidations() {
      return invalidations;
    },
    applyMove: (taskId, startsAt, endsAt) => {
      moves.push({ taskId, startsAt, endsAt });
    },
    invalidate: () => {
      invalidations++;
    },
  };
}

describe("applyGanttRealtimeEvent", () => {
  it("row.moved → applyMove with the moved window (no invalidate)", () => {
    const a = actions();
    const ev: gantt.GanttRealtimeEvent = {
      kind: "row.moved",
      eventId: "event_1",
      taskId: "task_a",
      startsAt: "2026-08-01T00:00:00Z",
      endsAt: "2026-08-05T00:00:00Z",
      at: "2026-08-01T00:00:00Z",
    };
    applyGanttRealtimeEvent(ev, a);
    expect(a.moves).toEqual([
      { taskId: "task_a", startsAt: "2026-08-01T00:00:00Z", endsAt: "2026-08-05T00:00:00Z" },
    ]);
    expect(a.invalidations).toBe(0);
  });

  it("row.moved carries nulls through (bar window cleared)", () => {
    const a = actions();
    applyGanttRealtimeEvent(
      { kind: "row.moved", eventId: "event_1", taskId: "task_b", startsAt: null, endsAt: null, at: "x" },
      a,
    );
    expect(a.moves).toEqual([{ taskId: "task_b", startsAt: null, endsAt: null }]);
  });

  it("chart.invalidated → invalidate (no move)", () => {
    const a = actions();
    applyGanttRealtimeEvent({ kind: "chart.invalidated", eventId: "event_1", reason: "task.created", at: "x" }, a);
    expect(a.invalidations).toBe(1);
    expect(a.moves).toEqual([]);
  });

  it("presence → no cache mutation (roster is UI state, handled in the hook)", () => {
    const a = actions();
    applyGanttRealtimeEvent(
      { kind: "presence", eventId: "event_1", users: [{ userId: "user_a" }], at: "x" },
      a,
    );
    expect(a.moves).toEqual([]);
    expect(a.invalidations).toBe(0);
  });

  it("dispatches purely on kind (a spy proves each branch fires exactly once)", () => {
    const applyMove = vi.fn();
    const invalidate = vi.fn();
    const a: GanttRealtimeActions = { applyMove, invalidate };
    applyGanttRealtimeEvent({ kind: "row.moved", eventId: "e", taskId: "t", startsAt: null, endsAt: null, at: "x" }, a);
    applyGanttRealtimeEvent({ kind: "chart.invalidated", eventId: "e", reason: "r", at: "x" }, a);
    expect(applyMove).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
