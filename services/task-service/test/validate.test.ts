import { describe, it, expect } from "vitest";
import { assertStatusTransition } from "../src/validate";

// Dependency cycle / unknown-ref detection moved to @dub/gantt-calc
// (single engine — see graph.test.ts in that package). Its integration with
// task-service is covered end-to-end in app.test.ts (PUT /tasks/:id/dependencies).

describe("assertStatusTransition", () => {
  it("allows legal transitions and no-ops", () => {
    expect(() => assertStatusTransition("todo", "in_progress")).not.toThrow();
    expect(() => assertStatusTransition("done", "in_progress")).not.toThrow(); // reopen
    expect(() => assertStatusTransition("todo", "todo")).not.toThrow();
  });

  it("rejects illegal transitions", () => {
    expect(() => assertStatusTransition("blocked", "done")).toThrow(); // must go via in_progress
    expect(() => assertStatusTransition("cancelled", "in_progress")).toThrow();
  });
});
