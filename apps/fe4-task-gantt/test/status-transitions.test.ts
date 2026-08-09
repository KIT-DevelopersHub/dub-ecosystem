import { describe, it, expect } from "vitest";
import { canTransition, droppableColumns, allowedTransitions, BOARD_COLUMNS } from "../src/domain/status-transitions";

describe("status-transitions (design test 2 pre-check / 8-2)", () => {
  it("board has the 5 frozen columns incl. blocked", () => {
    expect(BOARD_COLUMNS).toEqual(["todo", "in_progress", "blocked", "done", "cancelled"]);
  });

  it("todo -> in_progress allowed; identity move allowed", () => {
    expect(canTransition("todo", "in_progress")).toBe(true);
    expect(canTransition("todo", "todo")).toBe(true);
  });

  it("blocked cannot go straight to done (only via in_progress)", () => {
    expect(canTransition("blocked", "done")).toBe(false);
    expect(allowedTransitions("blocked")).not.toContain("done");
  });

  it("droppableColumns reflects the transition table (drop-disable UI)", () => {
    const cols = droppableColumns("done"); // done only reopens to in_progress
    expect(cols).toContain("done"); // identity
    expect(cols).toContain("in_progress");
    expect(cols).not.toContain("todo");
  });
});
