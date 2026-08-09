import { describe, it, expect } from "vitest";
import { identity, task } from "@dub/types";
import {
  isTaskStatus,
  isTaskPriority,
  isTaskOrigin,
  isPermissionKey,
  isUserStatus,
  isMailProvider,
  isTaskStatusTransitionAllowed,
  ENUM_SETS,
} from "../src/index";

describe("contract enum guards", () => {
  it("isTaskStatus accepts every frozen status and rejects others", () => {
    for (const s of Object.keys(task.TASK_STATUS_TRANSITIONS)) {
      expect(isTaskStatus(s)).toBe(true);
    }
    expect(isTaskStatus("archived")).toBe(false);
    expect(isTaskStatus("")).toBe(false);
    expect(isTaskStatus(undefined)).toBe(false);
    expect(isTaskStatus(3)).toBe(false);
  });

  it("guard set stays in lockstep with the @dub/types source of truth", () => {
    // Derived, not re-typed: the set must equal the transition-table keys exactly.
    expect([...ENUM_SETS.taskStatus].sort()).toEqual(
      Object.keys(task.TASK_STATUS_TRANSITIONS).sort(),
    );
    expect([...ENUM_SETS.permissionKey].sort()).toEqual(
      identity.PERMISSION_CATALOG.map((e) => e.key).sort(),
    );
    expect(ENUM_SETS.permissionKey.size).toBe(23);
  });

  it("isTaskPriority / isTaskOrigin", () => {
    expect(isTaskPriority("urgent")).toBe(true);
    expect(isTaskPriority("critical")).toBe(false);
    expect(isTaskOrigin("github")).toBe(true);
    expect(isTaskOrigin("import")).toBe(false);
  });

  it("isPermissionKey against the catalog", () => {
    expect(isPermissionKey("task:write")).toBe(true);
    expect(isPermissionKey("task:*")).toBe(false);
    expect(isPermissionKey("nope:read")).toBe(false);
  });

  it("isUserStatus / isMailProvider", () => {
    expect(isUserStatus("invited")).toBe(true);
    expect(isUserStatus("pending")).toBe(false);
    expect(isMailProvider("ses")).toBe(true);
    expect(isMailProvider("sendgrid")).toBe(false);
  });

  it("isTaskStatusTransitionAllowed honors the frozen table", () => {
    expect(isTaskStatusTransitionAllowed("todo", "in_progress")).toBe(true);
    expect(isTaskStatusTransitionAllowed("todo", "todo")).toBe(true); // identity
    expect(isTaskStatusTransitionAllowed("blocked", "done")).toBe(false); // via in_progress only
    expect(isTaskStatusTransitionAllowed("done", "in_progress")).toBe(true); // reopen
    expect(isTaskStatusTransitionAllowed("done", "todo")).toBe(false);
  });
});
