import { describe, it, expect } from "vitest";
import type { task as taskNs } from "@dub/types";
import { begin, commit, rollback, settled, canTransition, statusPatch, isVersionConflict } from "../src/optimistic.js";
import { fromResponseBody } from "../src/errors.js";
import { errBody } from "./helpers.js";

function sampleTask(over: Partial<taskNs.Task> = {}): taskNs.Task {
  return {
    id: "task_1",
    eventId: "evt_1",
    title: "Ship it",
    description: null,
    status: "in_progress",
    priority: "medium",
    assigneeId: "u1",
    dueAt: null,
    origin: "internal",
    archivedAt: null,
    createdAt: "2026-08-09T00:00:00Z",
    updatedAt: "2026-08-09T00:00:00Z",
    version: 3,
    ...over,
  };
}

describe("optimistic task UI (design §5 S5, §6 CONFLICT)", () => {
  it("honours the frozen transition table", () => {
    expect(canTransition("in_progress", "done")).toBe(true);
    expect(canTransition("done", "todo")).toBe(false); // done reopens only to in_progress
    expect(canTransition("blocked", "done")).toBe(false);
    expect(canTransition("todo", "todo")).toBe(true);
  });

  it("begin shows the next value and keeps a rollback snapshot", () => {
    const s = begin("todo", "done");
    expect(s.value).toBe("done");
    expect(s.rollbackTo).toBe("todo");
    expect(s.pending).toBe(true);
  });

  it("commit adopts the server value and settles", () => {
    const s = commit(begin("todo", "done"), "done");
    expect(s).toEqual(settled("done"));
    expect(s.pending).toBe(false);
  });

  it("rollback restores the pre-edit value on 409", () => {
    const s = rollback(begin("todo", "done"));
    expect(s.value).toBe("todo");
    expect(s.pending).toBe(false);
  });

  it("rollback is a no-op when already settled", () => {
    expect(rollback(settled("blocked")).value).toBe("blocked");
  });

  it("statusPatch carries the current version (baseVersion)", () => {
    expect(statusPatch(sampleTask({ version: 7 }), "done")).toEqual({ version: 7, status: "done" });
  });

  it("recognises a version-conflict error", () => {
    expect(isVersionConflict(fromResponseBody(409, errBody("TASK_VERSION_CONFLICT")))).toBe(true);
    expect(isVersionConflict(fromResponseBody(403, errBody("FORBIDDEN")))).toBe(false);
  });
});
